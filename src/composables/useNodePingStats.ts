import type { MaybeRefOrGetter } from 'vue'
import type { MetricLossPoint, NodePingHistoryPoint, NodePingStatsState } from '@/utils/pingStats'
import type { MetricQueryResponse, PingMetricStatsResponse, PingMetricTaskStats, PingRecord } from '@/utils/rpc'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { PANDA_OPS_PING_STALE_AFTER_MS } from '@/constants/pandaOps'
import { SharedCache } from '@/services/cache.service'
import { abortPingRecords, loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, loadPublicPingTasks, partitionMetricEntityIds, queryMetrics } from '@/services/metrics.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { buildNodePingStats, createEmptyNodePingStats, matchesPingTaskName, normalizeExactPingTaskName, normalizePingTaskFilter } from '@/utils/pingStats'

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface SharedPingRecordsState {
  recordsByClient: Map<string, PingRecord[]>
  source: 'metric' | 'legacy'
  metricStats?: PingMetricTaskStats[]
  metricLossPoints?: MetricLossPoint[]
  taskNamesById: Map<number, string>
}

interface SharedPingRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedPingRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  subscribers: number
  lastFetchedAt: number
}

interface PingRefreshGroup {
  hours: number
  maxCount?: number
  entries: Map<string, { entry: SharedPingRecordsEntry, uuid?: string }>
}

interface PendingMetricBatch {
  hours: number
  maxCount?: number
  uuids: Map<string, Array<(state: SharedPingRecordsState | null) => void>>
  scheduled: boolean
}

// Exact task matching no longer removes separators. Bump the persisted schema
// so results aggregated with the old looser semantics cannot leak forward.
const CACHE_VERSION = 12
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const CACHE_INDEX_KEY = `${CACHE_KEY_PREFIX}:index`
const PING_RECORD_REFRESH_INTERVAL_MS = 60_000
const sharedPingRecordsCache = new SharedCache<SharedPingRecordsEntry>({
  maxSize: CACHE_CONFIG.pingRecords.maxSize,
  ttl: CACHE_CONFIG.pingRecords.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
  canEvict: entry => entry.subscribers === 0 && entry.promise === null,
})
const pingRefreshGroups = new Map<string, PingRefreshGroup>()
const pendingMetricBatches = new Map<string, PendingMetricBatch>()
const pendingStatsCacheTouches = new Map<string, number>()
let statsCacheIndexFlushQueued = false
const pingFreshnessTick = ref(Date.now())
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
  if (pageIsVisible())
    refreshAllPingGroups()
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

type PingTaskNameMatch = 'contains' | 'exact'

function getCacheKey(uuid: string, hours: number, maxCount?: number, taskNameFilter = '', taskNameMatch: PingTaskNameMatch = 'contains'): string {
  const normalizedFilter = taskNameMatch === 'exact'
    ? normalizeExactPingTaskName(taskNameFilter)
    : normalizePingTaskFilter(taskNameFilter)
  return `${CACHE_KEY_PREFIX}:${uuid}:${hours}:${maxCount ?? 'all'}:${taskNameMatch}:${normalizedFilter || 'all'}`
}

function matchesTaskName(name: string, normalizedFilter: string, match: PingTaskNameMatch): boolean {
  return matchesPingTaskName(name, normalizedFilter, match === 'exact')
}

function normalizeTaskNameFilter(value: string, match: PingTaskNameMatch): string {
  return match === 'exact' ? normalizeExactPingTaskName(value) : normalizePingTaskFilter(value)
}

function getSharedPingRecordsKey(hours: number, maxCount?: number, uuid?: string): string {
  return `${uuid?.trim() || 'all'}:${hours}:${maxCount ?? 'all'}`
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
    && typeof state.avgVolatility === 'number'
    && (state.p50Latency === null || typeof state.p50Latency === 'number')
    && (state.p95Latency === null || typeof state.p95Latency === 'number')
    && (state.availability === null || typeof state.availability === 'number')
    && typeof state.sampleCount === 'number'
    && typeof state.hasData === 'boolean'
    && Array.isArray(state.history)
    && state.history.every(isValidHistoryPoint)
}

interface StatsCacheIndexEntry {
  key: string
  updatedAt: number
}

function readStatsCacheIndex(): StatsCacheIndexEntry[] {
  try {
    const raw = window.localStorage.getItem(CACHE_INDEX_KEY)
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
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index)
    if (!key || key === CACHE_INDEX_KEY || !key.startsWith(`${CACHE_KEY_PREFIX}:`))
      continue
    try {
      const cached = JSON.parse(window.localStorage.getItem(key) ?? '') as { updatedAt?: unknown }
      const updatedAt = typeof cached.updatedAt === 'string' ? Date.parse(cached.updatedAt) : Number.NaN
      if (Number.isFinite(updatedAt))
        entries.push({ key, updatedAt })
    }
    catch {
      window.localStorage.removeItem(key)
    }
  }
  return entries
}

function writeStatsCacheIndex(entries: StatsCacheIndexEntry[]): void {
  const ordered = entries.sort((left, right) => right.updatedAt - left.updatedAt)
  const retained = ordered.slice(0, CACHE_CONFIG.pingRecords.localStorageMaxSize)
  for (const entry of ordered.slice(retained.length))
    window.localStorage.removeItem(entry.key)
  window.localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(retained))
}

function flushStatsCacheTouches(): void {
  statsCacheIndexFlushQueued = false
  if (!pendingStatsCacheTouches.size)
    return

  const entriesByKey = new Map(readStatsCacheIndex().map(entry => [entry.key, entry]))
  for (const [key, updatedAt] of pendingStatsCacheTouches)
    entriesByKey.set(key, { key, updatedAt })
  pendingStatsCacheTouches.clear()
  writeStatsCacheIndex([...entriesByKey.values()])
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
  window.localStorage.removeItem(key)
  writeStatsCacheIndex(readStatsCacheIndex().filter(entry => entry.key !== key))
}

function readStatsCache(uuid: string, hours: number, maxCount?: number, taskNameFilter = '', taskNameMatch: PingTaskNameMatch = 'contains'): NodePingStatsState | null {
  if (typeof window === 'undefined')
    return null

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter, taskNameMatch)
    const raw = window.localStorage.getItem(key)
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { version?: number, updatedAt?: unknown, stats?: unknown }
    if (parsed.version !== CACHE_VERSION || !isValidStatsState(parsed.stats)) {
      removeStatsCacheKey(key)
      return null
    }

    const updatedAt = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : Number.NaN
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > PANDA_OPS_PING_STALE_AFTER_MS) {
      removeStatsCacheKey(key)
      return null
    }

    return parsed.stats
  }
  catch {
    return null
  }
}

function writeStatsCache(uuid: string, hours: number, maxCount: number | undefined, value: NodePingStatsState, taskNameFilter = '', taskNameMatch: PingTaskNameMatch = 'contains'): void {
  if (typeof window === 'undefined')
    return

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter, taskNameMatch)
    const updatedAt = Date.now()
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date(updatedAt).toISOString(),
        stats: value,
      }),
    )
    touchStatsCacheKey(key, updatedAt)
  }
  catch {
  }
}

function createSharedPingRecordsEntry(): SharedPingRecordsEntry {
  return {
    data: shallowRef<SharedPingRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    subscribers: 0,
    lastFetchedAt: 0,
  }
}

function getSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): SharedPingRecordsEntry {
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

function normalizeTaskId(taskId: string): number {
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

function buildMetricRecordsByClient(nodeUuid: string, stats: PingMetricTaskStats[], records: PingRecord[]): Map<string, PingRecord[]> {
  const grouped = buildRecordsByClient(records)
  if (grouped.size)
    return grouped

  const syntheticRecords = stats
    .filter(stat => stat.entity_id === nodeUuid && typeof stat.latest === 'number' && Number.isFinite(stat.latest))
    .map((stat): PingRecord => ({
      client: nodeUuid,
      task_id: normalizeTaskId(stat.task_id),
      time: new Date().toISOString(),
      value: stat.latest!,
    }))

  return buildRecordsByClient(syntheticRecords)
}

function buildPingMetricState(
  nodeUuid: string,
  statsResponse: PingMetricStatsResponse | null,
  metricsResponse: MetricQueryResponse | null,
): SharedPingRecordsState | null {
  const stats = (statsResponse?.stats ?? []).filter(stat => stat.entity_id === nodeUuid)
  const metricRecords: PingRecord[] = []
  const metricLossPoints: MetricLossPoint[] = []
  const metricLossTaskIds = new Set<number>()

  if (metricsResponse) {
    const seriesList = normalizeMetricSeriesList(metricsResponse.series)
    for (const series of seriesList) {
      if (series.entity_id !== nodeUuid)
        continue

      const taskId = normalizeTaskId(pingTaskId(series))
      if (!Number.isFinite(taskId))
        continue

      if (series.metric_key === PING_LOSS_METRIC) {
        for (const point of series.points) {
          if (!isFiniteNumber(point.value))
            continue

          metricLossPoints.push({
            time: point.time,
            value: point.value,
            count: isFiniteNumber(point.count) && point.count > 0 ? point.count : 1,
            taskId,
          })
          metricLossTaskIds.add(taskId)
        }
        continue
      }

      if (!isPingMetric(series))
        continue

      for (const point of series.points) {
        if (point.value === null)
          continue

        metricRecords.push({
          client: series.entity_id,
          task_id: taskId,
          time: point.time,
          value: point.value,
        })
      }
    }
  }

  const recordsByClient = buildMetricRecordsByClient(nodeUuid, stats, metricRecords)
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
    taskNamesById: new Map(),
  }
}

function getPingMetricBatchKey(hours: number, maxCount?: number): string {
  return `${hours}:${maxCount ?? 'all'}`
}

async function flushPingMetricBatch(key: string, batch: PendingMetricBatch): Promise<void> {
  pendingMetricBatches.delete(key)
  batch.scheduled = false
  const entityBatches = partitionMetricEntityIds([...batch.uuids.keys()])

  await Promise.all(entityBatches.map(async (entityIds) => {
    const [statsResult, metricsResult] = await Promise.allSettled([
      loadPingMetricStats({ entity_ids: entityIds, hours: batch.hours, max_points: batch.maxCount }),
      queryMetrics({
        metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
        entity_ids: entityIds,
        hours: batch.hours,
        downsample: true,
        fill_empty: true,
        max_points: batch.maxCount,
        aggregation: 'avg',
      }),
    ])
    const statsResponse = statsResult.status === 'fulfilled' ? statsResult.value : null
    const metricsResponse = metricsResult.status === 'fulfilled' ? metricsResult.value : null

    for (const uuid of entityIds) {
      const resolvers = batch.uuids.get(uuid) ?? []
      const state = buildPingMetricState(uuid, statsResponse, metricsResponse)
      for (const resolve of resolvers)
        resolve(state)
    }
  }))
}

function loadPingMetricRecords(nodeUuid: string, hours: number, maxCount?: number): Promise<SharedPingRecordsState | null> {
  const key = getPingMetricBatchKey(hours, maxCount)
  let batch = pendingMetricBatches.get(key)
  if (!batch) {
    batch = { hours, maxCount, uuids: new Map(), scheduled: false }
    pendingMetricBatches.set(key, batch)
  }

  return new Promise((resolve) => {
    const resolvers = batch!.uuids.get(nodeUuid) ?? []
    resolvers.push(resolve)
    batch!.uuids.set(nodeUuid, resolvers)
    if (batch!.scheduled)
      return
    batch!.scheduled = true
    queueMicrotask(() => {
      void flushPingMetricBatch(key, batch!)
    })
  })
}

async function loadSharedPingRecords(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, nodeUuid?: string): Promise<void> {
  if (entry.promise)
    return entry.promise

  entry.loading.value = true
  entry.error.value = null

  entry.promise = (async () => {
    try {
      const [metricState, pingTasks] = await Promise.all([
        nodeUuid ? loadPingMetricRecords(nodeUuid, hours, maxCount).catch(() => null) : Promise.resolve(null),
        loadPublicPingTasks().catch(() => []),
      ])
      const taskNamesById = new Map(pingTasks.map(task => [normalizeTaskId(String(task.id)), task.name]))
      for (const stat of metricState?.metricStats ?? []) {
        if (stat.name?.trim())
          taskNamesById.set(normalizeTaskId(stat.task_id), stat.name.trim())
      }
      if (entry.subscribers === 0)
        return

      if (metricState) {
        entry.data.value = { ...metricState, taskNamesById }
      }
      else {
        const { records, tasks } = await loadPingRecordsWithTasks(hours, maxCount, nodeUuid)
        for (const task of tasks) {
          const name = task.name.trim()
          const taskId = normalizeTaskId(String(task.id))
          if (name && !taskNamesById.has(taskId))
            taskNamesById.set(taskId, name)
        }
        if (entry.subscribers === 0)
          return
        entry.data.value = {
          recordsByClient: buildRecordsByClient(records),
          source: 'legacy',
          taskNamesById,
        }
      }
      entry.lastFetchedAt = Date.now()
    }
    catch (err) {
      entry.error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      throw err
    }
    finally {
      entry.loading.value = false
      entry.promise = null
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

function retainSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): () => void {
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
      abortPingRecords(hours, maxCount, uuid)
      sharedPingRecordsCache.sweep()
    }
  }
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
    taskNameFilter?: MaybeRefOrGetter<string>
    taskNameMatch?: MaybeRefOrGetter<PingTaskNameMatch>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    const taskNameFilter = toValue(options?.taskNameFilter)?.trim() ?? ''
    const taskNameMatch: PingTaskNameMatch = toValue(options?.taskNameMatch) === 'exact' ? 'exact' : 'contains'
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedPingRecordsKey(hours, maxCount, toValue(uuid)),
      taskNameFilter,
      taskNameMatch,
      enabled: toValue(options?.enabled) ?? true,
    }
  })

  let activeCacheKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number, uuid?: string): void {
    const cacheKey = hours === null ? null : getSharedPingRecordsKey(hours, maxCount, uuid)
    if (activeCacheKey === cacheKey)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeCacheKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedPingRecordsEntry(hours, maxCount, uuid)
    activeCacheKey = cacheKey
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  // stats 由共享 getRecords 结果派生；共享记录每分钟刷新一次后会自动重算。
  const stats = computed<NodePingStatsState>(() => {
    // 即使网络刷新失败，也要按分钟重新校验 localStorage，避免已经过期的
    // 历史数据在页面常驻期间无限展示。
    void pingFreshnessTick.value
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return createEmptyNodePingStats()

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state)
      return readStatsCache(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch) ?? createEmptyNodePingStats()

    const normalizedFilter = normalizeTaskNameFilter(taskNameFilter, taskNameMatch)
    const matchingTaskIds = normalizedFilter
      ? new Set([...state.taskNamesById.entries()]
          .filter(([, name]) => matchesTaskName(name, normalizedFilter, taskNameMatch))
          .map(([taskId]) => taskId))
      : null
    const records = (state.recordsByClient.get(nodeUuid) ?? [])
      .filter(record => !matchingTaskIds || matchingTaskIds.has(record.task_id))
    const metricStats = state.metricStats?.filter(stat => !matchingTaskIds || matchingTaskIds.has(normalizeTaskId(stat.task_id)))
    const metricLossPoints = state.metricLossPoints?.filter(point => !matchingTaskIds || matchingTaskIds.has(point.taskId))
    return records.length || metricStats?.length
      ? buildNodePingStats(records, metricStats, metricLossPoints)
      : createEmptyNodePingStats()
  })

  const taskNames = computed<string[]>(() => {
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return []

    const state = getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value
    if (!state)
      return []

    const normalizedFilter = normalizeTaskNameFilter(taskNameFilter, taskNameMatch)
    return [...new Set([...state.taskNamesById.values()]
      .filter(name => matchesTaskName(name, normalizedFilter, taskNameMatch)))]
  })

  const lastFetchedAt = computed(() => {
    void pingFreshnessTick.value
    const { uuid: nodeUuid, hours, maxCount, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return 0
    return getSharedPingRecordsEntry(hours, maxCount, nodeUuid).lastFetchedAt
  })

  const stale = computed(() => {
    if (!stats.value.hasData)
      return false
    const fetchedAt = lastFetchedAt.value
    return fetchedAt > 0 && pingFreshnessTick.value - fetchedAt > PANDA_OPS_PING_STALE_AFTER_MS
  })

  // 副作用：按需触发首次共享加载并维护 loading/error，不再命令式写入 stats。
  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, enabled } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
      const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
      const shouldLoadRecords = !entry.data.value
        || Date.now() - entry.lastFetchedAt >= PING_RECORD_REFRESH_INTERVAL_MS

      if (!shouldLoadRecords) {
        loading.value = false
        error.value = null
        return
      }

      const shouldShowLoading = !entry.data.value
      loading.value = shouldShowLoading
      error.value = null

      try {
        await loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
      }
      catch (err) {
        if (!cancelled && shouldShowLoading)
          error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      }
      finally {
        if (!cancelled)
          loading.value = false
      }
    },
    { immediate: true },
  )

  // 共享记录会定时刷新，节流回写 localStorage，避免多节点同时重算时密集写盘。
  const persistStats = useThrottleFn(
    (nodeUuid: string, hours: number, maxCount: number | undefined, taskNameFilter: string, taskNameMatch: PingTaskNameMatch, value: NodePingStatsState) => {
      writeStatsCache(nodeUuid, hours, maxCount, value, taskNameFilter, taskNameMatch)
    },
    30_000,
    true,
    true,
  )

  watch(stats, (value) => {
    if (!value.hasData)
      return
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (enabled && nodeUuid.trim())
      persistStats(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, value)
  })

  return {
    stats,
    loading,
    error,
    history: computed(() => stats.value.history),
    avgLatency: computed(() => stats.value.avgLatency),
    avgLoss: computed(() => stats.value.avgLoss),
    avgVolatility: computed(() => stats.value.avgVolatility),
    p50Latency: computed(() => stats.value.p50Latency),
    p95Latency: computed(() => stats.value.p95Latency),
    availability: computed(() => stats.value.availability),
    sampleCount: computed(() => stats.value.sampleCount),
    hasData: computed(() => stats.value.hasData),
    lastFetchedAt,
    stale,
    taskNames,
  }
}

export type ChinaCarrierKey = 'unicom' | 'telecom' | 'mobile'
export type { NodePingHistoryPoint, NodePingStatsState } from '@/utils/pingStats'

interface NodeCarrierPingOptions {
  hours?: MaybeRefOrGetter<number>
  enabled?: MaybeRefOrGetter<boolean>
  maxCount?: MaybeRefOrGetter<number | undefined>
  taskNameFilter?: MaybeRefOrGetter<string>
}

const CHINA_CARRIERS = [
  { key: 'unicom', labelZh: '联通', labelEn: 'Unicom' },
  { key: 'telecom', labelZh: '电信', labelEn: 'Telecom' },
  { key: 'mobile', labelZh: '移动', labelEn: 'Mobile' },
] as const

export function useNodeCarrierPingStats(uuid: MaybeRefOrGetter<string>, options?: NodeCarrierPingOptions) {
  const carrierPings = CHINA_CARRIERS.map((carrier) => {
    const taskNameFilter = computed(() => `${toValue(options?.taskNameFilter)?.trim() ?? ''}${carrier.labelZh}`)
    return {
      ...carrier,
      ping: useNodePingStats(uuid, {
        hours: options?.hours,
        enabled: options?.enabled,
        maxCount: options?.maxCount,
        taskNameFilter,
      }),
    }
  })

  return {
    carriers: computed(() => carrierPings.map(carrier => ({
      key: carrier.key,
      labelZh: carrier.labelZh,
      labelEn: carrier.labelEn,
      taskNames: carrier.ping.taskNames.value,
      stats: carrier.ping.stats.value,
      hasLatency: carrier.ping.hasData.value && carrier.ping.avgLatency.value > 0,
      stale: carrier.ping.stale.value,
    }))),
    loading: computed(() => carrierPings.some(carrier => carrier.ping.loading.value)),
    error: computed(() => carrierPings.map(carrier => carrier.ping.error.value).find(Boolean) ?? null),
    stale: computed(() => carrierPings.some(carrier => carrier.ping.stale.value)),
  }
}
