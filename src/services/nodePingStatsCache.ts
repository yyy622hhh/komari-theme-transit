import type { NodePingHistoryPoint, NodePingStatsState } from '@/utils/pingStats'
import { CACHE_CONFIG } from '@/constants/cache'
import { OPS_PING_FRESHNESS } from '@/constants/ops'
import { normalizeExactPingTaskName, normalizePingTaskFilter } from '@/utils/pingStats'
import { normalizeCarrierPingTaskName } from '@/utils/topologyPresets'

export type PingTaskNameMatch = 'contains' | 'exact' | 'normalized-exact'

const CACHE_VERSION = 17
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const CACHE_INDEX_KEY = `${CACHE_KEY_PREFIX}:index`
const pendingStatsCacheTouches = new Map<string, number>()
let statsCacheIndexFlushQueued = false

export function clearNodePingStatsCache(): void {
  pendingStatsCacheTouches.clear()
  if (typeof localStorage === 'undefined')
    return
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith(`${CACHE_KEY_PREFIX}:`))
        localStorage.removeItem(key)
    }
    localStorage.removeItem(CACHE_INDEX_KEY)
  }
  catch {
    // The cache is optional; live statistics still use the new epoch immediately.
  }
}

function getCacheKey(uuid: string, hours: number, maxCount?: number, taskNameFilter = '', taskNameMatch: PingTaskNameMatch = 'contains', taskType = ''): string {
  const normalizedFilter = taskNameMatch === 'exact'
    ? normalizeExactPingTaskName(taskNameFilter)
    : taskNameMatch === 'normalized-exact' ? normalizeCarrierPingTaskName(taskNameFilter) : normalizePingTaskFilter(taskNameFilter)
  return `${CACHE_KEY_PREFIX}:${uuid}:${hours}:${maxCount ?? 'all'}:${taskNameMatch}:${normalizedFilter || 'all'}:${taskType.trim().toLowerCase() || 'any'}`
}

function isValidHistoryPoint(value: unknown): value is NodePingHistoryPoint {
  if (!value || typeof value !== 'object')
    return false

  const point = value as Record<string, unknown>
  const latency = point.latency
  const loss = point.loss

  return typeof point.time === 'string'
    && (latency === null || typeof latency === 'number')
    && (loss === null || typeof loss === 'number')
}

function isValidStatsState(value: unknown): value is NodePingStatsState {
  if (!value || typeof value !== 'object')
    return false

  const state = value as Record<string, unknown>
  return typeof state.avgLatency === 'number'
    && typeof state.avgLoss === 'number'
    && typeof state.lineLoss === 'number'
    && typeof state.commonModeLossEvents === 'number'
    && typeof state.avgVolatility === 'number'
    && (state.p50Latency === null || typeof state.p50Latency === 'number')
    && (state.p95Latency === null || typeof state.p95Latency === 'number')
    && (state.availability === null || typeof state.availability === 'number')
    && typeof state.sampleCount === 'number'
    && typeof state.latencySampleCount === 'number' && Number.isFinite(state.latencySampleCount)
    && state.latencySampleCount >= 0 && state.latencySampleCount <= state.sampleCount
    && typeof state.hasData === 'boolean'
    && typeof state.hasLatencyData === 'boolean'
    && Array.isArray(state.history)
    && state.history.every(isValidHistoryPoint)
}

interface StatsCacheIndexEntry {
  key: string
  updatedAt: number
}

function readStatsCacheIndex(): StatsCacheIndexEntry[] {
  try {
    const raw = localStorage.getItem(CACHE_INDEX_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is StatsCacheIndexEntry => Boolean(
          entry
          && typeof entry === 'object'
          && typeof (entry as StatsCacheIndexEntry).key === 'string'
          && (entry as StatsCacheIndexEntry).key.startsWith(`${CACHE_KEY_PREFIX}:`)
          && Number.isFinite((entry as StatsCacheIndexEntry).updatedAt),
        ))
      }
    }
  }
  catch {
  }

  const entries: StatsCacheIndexEntry[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key || key === CACHE_INDEX_KEY || !key.startsWith(`${CACHE_KEY_PREFIX}:`))
      continue
    try {
      const cached = JSON.parse(localStorage.getItem(key) ?? '') as { updatedAt?: unknown }
      const updatedAt = typeof cached.updatedAt === 'string' ? Date.parse(cached.updatedAt) : Number.NaN
      if (Number.isFinite(updatedAt))
        entries.push({ key, updatedAt })
    }
    catch {
      localStorage.removeItem(key)
    }
  }
  return entries
}

function writeStatsCacheIndex(entries: StatsCacheIndexEntry[]): void {
  const ordered = entries.sort((left, right) => right.updatedAt - left.updatedAt)
  const retained = ordered.slice(0, CACHE_CONFIG.pingRecords.localStorageMaxSize)
  for (const entry of ordered.slice(retained.length))
    localStorage.removeItem(entry.key)
  localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(retained))
}

function flushStatsCacheTouches(): void {
  statsCacheIndexFlushQueued = false
  if (!pendingStatsCacheTouches.size)
    return

  try {
    const entriesByKey = new Map(readStatsCacheIndex().map(entry => [entry.key, entry]))
    for (const [key, updatedAt] of pendingStatsCacheTouches)
      entriesByKey.set(key, { key, updatedAt })
    writeStatsCacheIndex([...entriesByKey.values()])
  }
  catch {
    // This runs after writeStatsCache returns; its caller's try/catch cannot
    // handle a quota or privacy-mode error in this microtask. Cache is optional.
  }
  finally {
    pendingStatsCacheTouches.clear()
  }
}

function touchStatsCacheKey(key: string, updatedAt: number): void {
  pendingStatsCacheTouches.set(key, updatedAt)
  if (statsCacheIndexFlushQueued)
    return
  statsCacheIndexFlushQueued = true
  queueMicrotask(flushStatsCacheTouches)
}

function removeStatsCacheKey(key: string): void {
  pendingStatsCacheTouches.delete(key)
  localStorage.removeItem(key)
  writeStatsCacheIndex(readStatsCacheIndex().filter(entry => entry.key !== key))
}

export interface CachedNodePingStats {
  stats: NodePingStatsState
  sampleUpdatedAt: number
}

export function readStatsCache(uuid: string, hours: number, maxCount?: number, taskNameFilter = '', taskNameMatch: PingTaskNameMatch = 'contains', taskType = ''): CachedNodePingStats | null {
  if (typeof localStorage === 'undefined')
    return null

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType)
    const raw = localStorage.getItem(key)
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { version?: number, updatedAt?: unknown, sampleUpdatedAt?: unknown, stats?: unknown }
    if (parsed.version !== CACHE_VERSION || !isValidStatsState(parsed.stats)) {
      removeStatsCacheKey(key)
      return null
    }

    const updatedAt = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : Number.NaN
    const sampleUpdatedAt = typeof parsed.sampleUpdatedAt === 'string' ? Date.parse(parsed.sampleUpdatedAt) : Number.NaN
    if (!Number.isFinite(updatedAt)
      || !Number.isFinite(sampleUpdatedAt)
      || Date.now() - sampleUpdatedAt >= OPS_PING_FRESHNESS.staleAfterMs) {
      removeStatsCacheKey(key)
      return null
    }

    return { stats: parsed.stats, sampleUpdatedAt }
  }
  catch {
    return null
  }
}

export function writeStatsCache(
  uuid: string,
  hours: number,
  maxCount: number | undefined,
  value: NodePingStatsState,
  sampleUpdatedAt: number,
  taskNameFilter = '',
  taskNameMatch: PingTaskNameMatch = 'contains',
  taskType = '',
): void {
  if (typeof localStorage === 'undefined')
    return
  if (!Number.isFinite(sampleUpdatedAt) || sampleUpdatedAt <= 0)
    return

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType)
    const updatedAt = Date.now()
    localStorage.setItem(
      key,
      JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date(updatedAt).toISOString(),
        sampleUpdatedAt: new Date(sampleUpdatedAt).toISOString(),
        stats: value,
      }),
    )
    touchStatsCacheKey(key, updatedAt)
  }
  catch {
  }
}
