import type { MetricLossPoint } from '@/utils/pingStats'
import type { MetricQueryResponse, PingMetricStatsResponse, PingMetricTaskStats, PingRecord } from '@/utils/rpc'
import { ref, shallowRef } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { OPS_PING_FRESHNESS } from '@/constants/ops'
import { SharedCache } from '@/services/cache.service'
import { loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPublicPingTasks } from '@/services/metrics.service'
import { loadPingMetricBatch } from '@/services/ping-metric-batch.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { detectPingCommonModeLossKeys, getPingCommonModeLossKey } from '@/utils/pingCommonMode'
import { matchesPingTaskName, normalizeExactPingTaskName, normalizePingTaskFilter } from '@/utils/pingStats'
import { normalizeCarrierPingTaskName } from '@/utils/topologyPresets'

export function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export interface SharedPingRecordsState {
  recordsByClient: Map<string, PingRecord[]>
  source: 'metric' | 'legacy'
  metricStats?: PingMetricTaskStats[]
  metricLossPoints?: MetricLossPoint[]
  sampleUpdatedAtByTaskId: Map<number, number>
  taskNamesById: Map<number, string>
  taskClientsById: Map<number, Set<string>>
  rawRecordsByClient?: Map<string, PingRecord[]>
  taskIntervalsById?: Map<number, number>
  taskTypesById?: Map<number, string>
}

interface SharedPingRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedPingRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  controller: AbortController | null
  subscribers: number
  lastFetchedAt: number
}

interface PingRefreshGroup {
  hours: number
  maxCount?: number
  entries: Map<string, { entry: SharedPingRecordsEntry, uuid?: string }>
}

export const PING_RECORD_REFRESH_INTERVAL_MS = 60_000
const sharedPingRecordsCache = new SharedCache<SharedPingRecordsEntry>({
  maxSize: CACHE_CONFIG.pingRecords.maxSize,
  ttl: CACHE_CONFIG.pingRecords.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
  canEvict: entry => entry.subscribers === 0 && entry.promise === null,
})
const pingRefreshGroups = new Map<string, PingRefreshGroup>()
export const pingFreshnessTick = ref(Date.now())
export const pingFreshnessGraceUntil = ref(0)
let pingRefreshTimer: ReturnType<typeof setInterval> | null = null
let pingVisibilityListenerAttached = false

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function refreshAllPingGroups(): void {
  if (!pageIsVisible())
    return
  pingFreshnessTick.value = Date.now()
  for (const group of pingRefreshGroups.values())
    refreshPingGroup(group)
}

function handlePingVisibilityChange(): void {
  if (pageIsVisible()) {
    const now = Date.now()
    pingFreshnessGraceUntil.value = now + OPS_PING_FRESHNESS.resumeGraceMs
    pingFreshnessTick.value = now
    refreshAllPingGroups()
  }
}

function startPingRefreshScheduler(): void {
  if (pingRefreshTimer || typeof window === 'undefined')
    return
  pingRefreshTimer = window.setInterval(refreshAllPingGroups, PING_RECORD_REFRESH_INTERVAL_MS)
  if (!pingVisibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handlePingVisibilityChange)
    pingVisibilityListenerAttached = true
  }
}

function stopPingRefreshScheduler(): void {
  if (pingRefreshGroups.size > 0)
    return
  if (pingRefreshTimer) {
    clearInterval(pingRefreshTimer)
    pingRefreshTimer = null
  }
  if (pingVisibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handlePingVisibilityChange)
    pingVisibilityListenerAttached = false
  }
}

export type PingTaskNameMatch = 'contains' | 'exact' | 'normalized-exact'

export function matchesTaskName(name: string, normalizedFilter: string, match: PingTaskNameMatch): boolean {
  if (match === 'normalized-exact')
    return normalizeCarrierPingTaskName(name) === normalizeCarrierPingTaskName(normalizedFilter)
  return matchesPingTaskName(name, normalizedFilter, match === 'exact')
}

export function normalizeTaskNameFilter(value: string, match: PingTaskNameMatch): string {
  if (match === 'normalized-exact')
    return normalizeCarrierPingTaskName(value)
  return match === 'exact' ? normalizeExactPingTaskName(value) : normalizePingTaskFilter(value)
}

export function collectNodePingTaskIds(
  nodeUuid: string,
  records: readonly PingRecord[],
  metricStats: readonly Pick<PingMetricTaskStats, 'task_id'>[] = [],
  metricLossPoints: readonly Pick<MetricLossPoint, 'taskId'>[] = [],
  taskClientsById: ReadonlyMap<number, ReadonlySet<string>> = new Map(),
): Set<number> {
  const taskIds = new Set<number>()
  for (const record of records)
    taskIds.add(record.task_id)
  for (const stat of metricStats)
    taskIds.add(normalizeTaskId(stat.task_id))
  for (const point of metricLossPoints)
    taskIds.add(point.taskId)
  for (const [taskId, clients] of taskClientsById) {
    if (clients.has(nodeUuid))
      taskIds.add(taskId)
  }
  return taskIds
}

/**
 * 精确匹配撞到多个同名任务时，选健康样本优先、否则选 id 最大的那个。
 * 入口换挡会短暂留下两个同名任务，混算或直接空统计都会把图上的实时段打空。
 */
export function pickPreferredExactPingTaskId(
  matchingTaskIds: ReadonlySet<number>,
  options: {
    metricStats?: readonly Pick<PingMetricTaskStats, 'task_id' | 'total' | 'valid'>[]
    records?: readonly Pick<PingRecord, 'task_id' | 'value'>[]
  } = {},
): number | undefined {
  if (!matchingTaskIds.size)
    return undefined
  if (matchingTaskIds.size === 1)
    return [...matchingTaskIds][0]

  // Stats and series are separate reads, not one atomic backend snapshot.
  // Use success evidence from either, without adding their overlapping counts.
  const successful = new Set<number>()
  for (const stat of options.metricStats ?? []) {
    const taskId = normalizeTaskId(String(stat.task_id))
    if (!matchingTaskIds.has(taskId))
      continue
    if (Number.isFinite(stat.valid) && stat.valid > 0)
      successful.add(taskId)
  }
  for (const record of options.records ?? []) {
    if (matchingTaskIds.has(record.task_id) && Number.isFinite(record.value) && record.value >= 0)
      successful.add(record.task_id)
  }

  const rank = (taskId: number): number => successful.has(taskId) ? 1 : 0
  return [...matchingTaskIds].sort((left, right) => rank(right) - rank(left) || right - left)[0]
}

export function resolveExactMatchingTaskIds(
  matchingTaskIds: Set<number> | null,
  match: PingTaskNameMatch,
  metricStats?: readonly PingMetricTaskStats[],
  records: readonly PingRecord[] = [],
): Set<number> | null {
  if (!matchingTaskIds || (match !== 'exact' && match !== 'normalized-exact') || matchingTaskIds.size <= 1)
    return matchingTaskIds
  const preferred = pickPreferredExactPingTaskId(matchingTaskIds, { metricStats, records })
  return preferred === undefined ? matchingTaskIds : new Set([preferred])
}

export function getSharedPingRecordsKey(hours: number, maxCount?: number, uuid?: string): string {
  return `${uuid?.trim() || 'all'}:${hours}:${maxCount ?? 'all'}`
}

function createSharedPingRecordsEntry(): SharedPingRecordsEntry {
  return {
    data: shallowRef<SharedPingRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    controller: null,
    subscribers: 0,
    lastFetchedAt: 0,
  }
}

export function getSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): SharedPingRecordsEntry {
  const key = getSharedPingRecordsKey(hours, maxCount, uuid)
  const cachedEntry = sharedPingRecordsCache.get(key)
  if (cachedEntry)
    return cachedEntry

  const nextEntry = createSharedPingRecordsEntry()
  return sharedPingRecordsCache.set(key, nextEntry)
}

function buildRecordsByClient(records: PingRecord[]): Map<string, PingRecord[]> {
  const grouped = new Map<string, PingRecord[]>()

  for (const record of records) {
    if (!record.client)
      continue

    const clientRecords = grouped.get(record.client) ?? []
    clientRecords.push(record)
    grouped.set(record.client, clientRecords)
  }

  for (const clientRecords of grouped.values()) {
    clientRecords.sort(
      (left, right) => new Date(left.time).getTime() - new Date(right.time).getTime(),
    )
  }

  return grouped
}

function updateLatestSampleTime(target: Map<number, number>, taskId: number, time: string): void {
  const timestamp = Date.parse(time)
  if (!Number.isFinite(timestamp))
    return
  target.set(taskId, Math.max(target.get(taskId) ?? 0, timestamp))
}

export function buildSampleUpdatedAtByTaskId(records: readonly Pick<PingRecord, 'task_id' | 'time'>[]): Map<number, number> {
  const timestamps = new Map<number, number>()
  for (const record of records)
    updateLatestSampleTime(timestamps, record.task_id, record.time)
  return timestamps
}

export function normalizeTaskId(taskId: string): number {
  if (!taskId.trim())
    return Number.NaN

  const numericTaskId = Number(taskId)
  if (Number.isFinite(numericTaskId))
    return numericTaskId

  let hash = 0
  for (let index = 0; index < taskId.length; index++)
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0
  return Math.abs(hash)
}

function buildMetricRecordsByClient(
  nodeUuid: string,
  stats: PingMetricTaskStats[],
  records: PingRecord[],
  sampleUpdatedAtByTaskId: ReadonlyMap<number, number>,
): Map<string, PingRecord[]> {
  const grouped = buildRecordsByClient(records)
  if (grouped.size)
    return grouped

  const syntheticRecords = stats
    .filter(stat => stat.entity_id === nodeUuid && typeof stat.latest === 'number' && Number.isFinite(stat.latest))
    .flatMap((stat): PingRecord[] => {
      const taskId = normalizeTaskId(stat.task_id)
      const sampleUpdatedAt = sampleUpdatedAtByTaskId.get(taskId) ?? 0
      return sampleUpdatedAt > 0
        ? [{ client: nodeUuid, task_id: taskId, time: new Date(sampleUpdatedAt).toISOString(), value: stat.latest! }]
        : []
    })

  return buildRecordsByClient(syntheticRecords)
}

/**
 * 决定这一批采样能不能信 Metric Store：只有当每个有精确（非近似）丢包统计的
 * 任务都能在查询到的丢包时间序列里找到对应的点，才返回可用状态；否则返回
 * null，调用方据此回退到旧版 `common:getRecords`。
 */
export function buildPingMetricState(
  nodeUuid: string,
  statsResponse: PingMetricStatsResponse | null,
  metricsResponse: MetricQueryResponse | null,
  commonModeLossKeys: ReadonlySet<string> = detectPingCommonModeLossKeys(metricsResponse?.series ?? []),
): SharedPingRecordsState | null {
  const stats = (statsResponse?.stats ?? []).filter(stat => stat.entity_id === nodeUuid)
  const metricRecords: PingRecord[] = []
  const metricLossPoints: MetricLossPoint[] = []
  const metricLossTaskIds = new Set<number>()
  const sampleUpdatedAtByTaskId = new Map<number, number>()

  if (metricsResponse) {
    const seriesList = normalizeMetricSeriesList(metricsResponse.series)
    for (const series of seriesList) {
      if (series.entity_id !== nodeUuid)
        continue

      const rawTaskId = pingTaskId(series)
      const taskId = normalizeTaskId(rawTaskId)
      if (!Number.isFinite(taskId))
        continue

      if (series.metric_key === PING_LOSS_METRIC) {
        for (const point of series.points) {
          if (!isFiniteNumber(point.value) || (isFiniteNumber(point.count) && point.count <= 0))
            continue

          metricLossPoints.push({
            time: point.time,
            value: point.value,
            count: isFiniteNumber(point.count) && point.count > 0 ? point.count : 1,
            taskId,
            commonMode: commonModeLossKeys.has(getPingCommonModeLossKey(rawTaskId, point.time)),
          })
          updateLatestSampleTime(sampleUpdatedAtByTaskId, taskId, point.time)
          metricLossTaskIds.add(taskId)
        }
        continue
      }

      if (!isPingMetric(series))
        continue

      for (const point of series.points) {
        if (point.value === null || (isFiniteNumber(point.count) && point.count <= 0))
          continue

        metricRecords.push({
          client: series.entity_id,
          task_id: taskId,
          time: point.time,
          value: point.value,
        })
        updateLatestSampleTime(sampleUpdatedAtByTaskId, taskId, point.time)
      }
    }
  }

  const recordsByClient = buildMetricRecordsByClient(nodeUuid, stats, metricRecords, sampleUpdatedAtByTaskId)
  const exactLossTaskIds = new Set(
    stats
      .filter(stat => stat.total > 0 && !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => normalizeTaskId(stat.task_id)),
  )
  const hasCompleteLossSeries = exactLossTaskIds.size > 0
    && [...exactLossTaskIds].every(taskId => metricLossTaskIds.has(taskId))
  if (!hasCompleteLossSeries)
    return null

  return {
    recordsByClient,
    source: 'metric',
    metricStats: stats,
    metricLossPoints,
    sampleUpdatedAtByTaskId,
    taskNamesById: new Map(),
    taskClientsById: new Map(),
  }
}

function getPingMetricBatchKey(hours: number, maxCount?: number): string {
  return `${hours}:${maxCount ?? 'all'}`
}

async function loadPingMetricRecords(nodeUuid: string, hours: number, maxCount?: number): Promise<SharedPingRecordsState | null> {
  const batch = await loadPingMetricBatch(nodeUuid, hours, maxCount)
  if (!batch)
    return null
  const state = buildPingMetricState(nodeUuid, batch.stats, batch.metrics, batch.commonModeKeys)
  if (state)
    state.rawRecordsByClient = buildRecordsByClient(batch.raw.filter(record => record.client === nodeUuid))
  return state
}

export async function loadSharedPingRecords(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, nodeUuid?: string): Promise<void> {
  if (entry.promise) {
    if (!entry.controller?.signal.aborted)
      return entry.promise
    await entry.promise.catch(() => {})
    return loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
  }

  entry.loading.value = true
  entry.error.value = null
  const controller = new AbortController()
  entry.controller = controller

  entry.promise = (async () => {
    try {
      const [metricState, pingTasks] = await Promise.all([
        nodeUuid ? loadPingMetricRecords(nodeUuid, hours, maxCount).catch(() => null) : Promise.resolve(null),
        loadPublicPingTasks().catch(() => []),
      ])
      const taskNamesById = new Map(pingTasks.map(task => [normalizeTaskId(String(task.id)), task.name]))
      const taskIntervalsById = new Map(pingTasks.map(task => [normalizeTaskId(String(task.id)), task.interval]))
      const taskTypesById = new Map(pingTasks.map(task => [normalizeTaskId(String(task.id)), task.type ?? '']))
      const taskClientsById = new Map(pingTasks.map(task => [
        normalizeTaskId(String(task.id)),
        new Set(Array.isArray(task.clients) ? task.clients : []),
      ]))
      for (const stat of metricState?.metricStats ?? []) {
        if (stat.name?.trim())
          taskNamesById.set(normalizeTaskId(stat.task_id), stat.name.trim())
      }
      if (entry.subscribers === 0 || controller.signal.aborted)
        return

      if (metricState) {
        entry.data.value = { ...metricState, taskNamesById, taskClientsById, taskIntervalsById, taskTypesById }
      }
      else {
        const { records, tasks } = await loadPingRecordsWithTasks(hours, maxCount, nodeUuid, controller.signal)
        for (const task of tasks) {
          const name = task.name.trim()
          const taskId = normalizeTaskId(String(task.id))
          if (name && !taskNamesById.has(taskId))
            taskNamesById.set(taskId, name)
          if (!taskClientsById.has(taskId))
            taskClientsById.set(taskId, new Set(Array.isArray(task.clients) ? task.clients : []))
        }
        if (entry.subscribers === 0 || controller.signal.aborted)
          return
        entry.data.value = {
          recordsByClient: buildRecordsByClient(records),
          // Legacy records may be rollups. They remain useful history, never current proof.
          rawRecordsByClient: new Map(),
          taskIntervalsById,
          taskTypesById,
          source: 'legacy',
          sampleUpdatedAtByTaskId: buildSampleUpdatedAtByTaskId(records),
          taskNamesById,
          taskClientsById,
        }
      }
      entry.lastFetchedAt = Date.now()
      // lastFetchedAt 本身不是 Ref；同步推进时钟，确保成功刷新后立即清除过期状态。
      pingFreshnessTick.value = entry.lastFetchedAt
    }
    catch (err) {
      entry.error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      throw err
    }
    finally {
      entry.loading.value = false
      entry.promise = null
      if (entry.controller === controller)
        entry.controller = null
      sharedPingRecordsCache.sweep()
    }
  })()

  return entry.promise
}

function refreshPingGroup(group: PingRefreshGroup): void {
  for (const { entry, uuid } of group.entries.values()) {
    if (entry.subscribers > 0)
      void loadSharedPingRecords(entry, group.hours, group.maxCount, uuid).catch(() => {})
  }
}

function getOrCreatePingRefreshGroup(hours: number, maxCount?: number): PingRefreshGroup {
  const key = getPingMetricBatchKey(hours, maxCount)
  const existing = pingRefreshGroups.get(key)
  if (existing)
    return existing

  const group: PingRefreshGroup = {
    hours,
    maxCount,
    entries: new Map(),
  }
  pingRefreshGroups.set(key, group)
  startPingRefreshScheduler()
  return group
}

function releasePingRefreshGroupEntry(hours: number, maxCount: number | undefined, entryKey: string): void {
  const groupKey = getPingMetricBatchKey(hours, maxCount)
  const group = pingRefreshGroups.get(groupKey)
  if (!group)
    return
  group.entries.delete(entryKey)
  if (group.entries.size > 0)
    return
  pingRefreshGroups.delete(groupKey)
  stopPingRefreshScheduler()
}

export function retainSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): () => void {
  const entryKey = getSharedPingRecordsKey(hours, maxCount, uuid)
  const entry = getSharedPingRecordsEntry(hours, maxCount, uuid)
  entry.subscribers += 1
  getOrCreatePingRefreshGroup(hours, maxCount).entries.set(entryKey, { entry, uuid })

  let released = false
  return () => {
    if (released)
      return

    released = true
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0) {
      releasePingRefreshGroupEntry(hours, maxCount, entryKey)
      entry.controller?.abort()
      sharedPingRecordsCache.sweep()
    }
  }
}
