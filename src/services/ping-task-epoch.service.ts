import type { AdminPingTask } from '@/services/ping-task.model'
import type { MetricLossPoint } from '@/utils/pingStats'
import type { PingRecord, PingTaskInfo } from '@/utils/rpc'
import { ref } from 'vue'
import { clearNodePingStatsCache } from '@/services/nodePingStatsCache'

type ObservedPingTask = Pick<PingTaskInfo, 'id' | 'type' | 'target'> | Pick<AdminPingTask, 'id' | 'type' | 'target'>

/**
 * 公开目录和管理员目录来自两个不同的接口。公开目录目前不带 `target`，一旦
 * 哪天它开始带（哪怕格式和管理员接口不同，比如带不带端口号），两个目录轮流
 * 刷新时就会把彼此的指纹当成「目标变了」反复互相打架，纪元被无意义地反复
 * 重置、统计缓存跟着反复清空。两边的指纹分开存，只在同一来源内部比较。
 */
export type PingTaskObservationSource = 'public' | 'admin'

interface PingTaskEpochEntry {
  id: number
  probeType: string
  publicTargetFingerprint?: string
  adminTargetFingerprint?: string
  epochStartedAt: number
}

const STORAGE_KEY = 'transit:ping-task-epochs:v2'
const MAX_ENTRIES = 256
/** 类型字符串在校验里也要卡住这个长度，写入和读回两边必须用同一个上限。 */
const MAX_PROBE_TYPE_LENGTH = 16
let entries: Map<number, PingTaskEpochEntry> | null = null
let storageListenerInstalled = false

/** Makes a detected in-place edit invalidate reactive statistics immediately. */
export const pingTaskEpochRevision = ref(0)

function normalizeTaskId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function normalizeProbeType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, MAX_PROBE_TYPE_LENGTH) : ''
}

function fingerprintTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim())
    return undefined
  const target = value.trim()
  let left = 0x811C9DC5
  let right = 0x9E3779B9
  for (let index = 0; index < target.length; index++) {
    const code = target.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ code, 0x85EBCA6B)
  }
  return `${target.length.toString(16)}:${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

const FINGERPRINT_PATTERN = /^[0-9a-f]+:[0-9a-f]{16}$/

function isEpochEntry(value: unknown): value is PingTaskEpochEntry {
  if (!value || typeof value !== 'object')
    return false
  const entry = value as Partial<PingTaskEpochEntry>
  return normalizeTaskId(entry.id) !== null
    && typeof entry.probeType === 'string'
    && entry.probeType.length <= MAX_PROBE_TYPE_LENGTH
    && (entry.publicTargetFingerprint === undefined || FINGERPRINT_PATTERN.test(entry.publicTargetFingerprint))
    && (entry.adminTargetFingerprint === undefined || FINGERPRINT_PATTERN.test(entry.adminTargetFingerprint))
    && typeof entry.epochStartedAt === 'number'
    && Number.isFinite(entry.epochStartedAt)
    && entry.epochStartedAt >= 0
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === 'undefined')
    return
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY)
      return
    entries = null
    clearNodePingStatsCache()
    pingTaskEpochRevision.value += 1
  })
  storageListenerInstalled = true
}

function readEntries(): Map<number, PingTaskEpochEntry> {
  installStorageListener()
  if (entries)
    return entries
  entries = new Map()
  if (typeof localStorage === 'undefined')
    return entries
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (isEpochEntry(value)) {
          entries.set(value.id, {
            id: value.id,
            probeType: value.probeType,
            ...(value.publicTargetFingerprint ? { publicTargetFingerprint: value.publicTargetFingerprint } : {}),
            ...(value.adminTargetFingerprint ? { adminTargetFingerprint: value.adminTargetFingerprint } : {}),
            epochStartedAt: value.epochStartedAt,
          })
        }
      }
    }
  }
  catch {}
  return entries
}

function persistEntries(): void {
  if (typeof localStorage === 'undefined')
    return
  try {
    const retained = [...readEntries().values()]
      .sort((left, right) => right.id - left.id)
      .slice(0, MAX_ENTRIES)
    // Keep the live catalogue under the same bound as its persisted copy.
    // Otherwise a long-lived admin tab continues using entries that a reload
    // has already discarded and the map grows for the lifetime of the page.
    entries = new Map(retained.map(entry => [entry.id, entry]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(retained))
  }
  catch {
    // Epoch isolation remains active in memory when private mode or quota blocks persistence.
  }
}

/**
 * Observe an authoritative task catalogue without inventing a change boundary.
 *
 * Public Komari catalogues expose the probe type but currently omit the target. The first
 * observation from a given source therefore fills in that source's target baseline without
 * resetting history; only a later observed target change *from the same source* starts a new
 * epoch. This is deliberately conservative, and keeps the public and admin catalogues from
 * ever comparing their fingerprints against each other.
 */
export function observePingTaskEpochs(
  tasks: readonly ObservedPingTask[],
  source: PingTaskObservationSource,
  observedAt = Date.now(),
): number[] {
  const catalog = readEntries()
  const changedIds: number[] = []
  const safeObservedAt = Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now()
  const fingerprintKey = source === 'public' ? 'publicTargetFingerprint' : 'adminTargetFingerprint'
  let dirty = false

  for (const task of tasks) {
    const id = normalizeTaskId(task.id)
    if (id === null)
      continue
    const probeType = normalizeProbeType(task.type)
    const targetFingerprint = fingerprintTarget(task.target)
    const previous = catalog.get(id)
    if (!previous) {
      catalog.set(id, { id, probeType, ...(targetFingerprint ? { [fingerprintKey]: targetFingerprint } : {}), epochStartedAt: 0 })
      dirty = true
      continue
    }

    const previousFingerprint = previous[fingerprintKey]
    const typeChanged = Boolean(previous.probeType && probeType && previous.probeType !== probeType)
    const targetChanged = Boolean(previousFingerprint && targetFingerprint && previousFingerprint !== targetFingerprint)
    const epochStartedAt = typeChanged || targetChanged ? safeObservedAt : previous.epochStartedAt
    if (epochStartedAt !== previous.epochStartedAt)
      changedIds.push(id)
    const nextFingerprint = targetFingerprint || previousFingerprint
    const next: PingTaskEpochEntry = {
      id,
      probeType: probeType || previous.probeType,
      ...(source === 'public' ? { adminTargetFingerprint: previous.adminTargetFingerprint } : { publicTargetFingerprint: previous.publicTargetFingerprint }),
      ...(nextFingerprint ? { [fingerprintKey]: nextFingerprint } : {}),
      epochStartedAt,
    }
    if (next.probeType !== previous.probeType || next[fingerprintKey] !== previous[fingerprintKey] || next.epochStartedAt !== previous.epochStartedAt) {
      catalog.set(id, next)
      dirty = true
    }
  }

  if (dirty)
    persistEntries()
  if (changedIds.length) {
    clearNodePingStatsCache()
    pingTaskEpochRevision.value += 1
  }
  return changedIds
}

export function pingTaskEpochStartedAt(taskId: number): number {
  return readEntries().get(taskId)?.epochStartedAt ?? 0
}

export function isPingTaskSampleInCurrentEpoch(taskId: number, time: string): boolean {
  const cutoff = pingTaskEpochStartedAt(taskId)
  if (cutoff <= 0)
    return true
  const timestamp = Date.parse(time)
  return Number.isFinite(timestamp) && timestamp >= cutoff
}

export function filterPingRecordsToCurrentEpoch(records: readonly PingRecord[]): PingRecord[] {
  return records.filter(record => isPingTaskSampleInCurrentEpoch(record.task_id, record.time))
}

export function filterMetricLossToCurrentEpoch(points: readonly MetricLossPoint[]): MetricLossPoint[] {
  return points.filter(point => isPingTaskSampleInCurrentEpoch(point.taskId, point.time))
}

export function resetPingTaskEpochCache(): void {
  entries = null
  pingTaskEpochRevision.value += 1
}
