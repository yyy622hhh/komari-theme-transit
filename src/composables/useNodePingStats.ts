import type { MaybeRefOrGetter } from 'vue'
import type { MetricQueryResponse, PingMetricStatsResponse, PingMetricTaskStats } from '@/utils/rpc'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { PANDA_OPS_PING_STALE_AFTER_MS } from '@/constants/pandaOps'
import { TIME_MS } from '@/constants/time'
import { SharedCache } from '@/services/cache.service'
import { abortPingRecords, loadPingRecords } from '@/services/history.service'
import { loadPingMetricStats, loadPublicPingTasks, partitionMetricEntityIds, queryMetrics } from '@/services/metrics.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'

export interface NodePingHistoryPoint {
  time: string
  latency: number | null
  loss: number | null
}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  p50Latency: number | null
  p95Latency: number | null
  availability: number | null
  sampleCount: number
  history: NodePingHistoryPoint[]
  hasData: boolean
}

interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

interface MetricLossPoint {
  time: string
  value: number
  count: number
  taskId: number
}

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
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
  timer: ReturnType<typeof setInterval>
}

interface PendingMetricBatch {
  hours: number
  maxCount?: number
  uuids: Map<string, Array<(state: SharedPingRecordsState | null) => void>>
  scheduled: boolean
}

const HISTORY_BUCKET_COUNT = 20
const CACHE_VERSION = 11
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const CACHE_INDEX_KEY = `${CACHE_KEY_PREFIX}:index`
const FULL_LOSS_EPSILON = 1e-6
const PING_RECORD_REFRESH_INTERVAL_MS = 60_000
const TASK_FILTER_SEPARATOR_PATTERN = /[\s\-_—–·]+/g
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

if (typeof window !== 'undefined') {
  window.setInterval(() => {
    pingFreshnessTick.value = Date.now()
  }, TIME_MS.minute)
}

interface TaskRecordSummary {
  total: number
  success: number
}

function createEmptyStats(): NodePingStatsState {
  return {
    avgLatency: 0,
    avgLoss: 0,
    avgVolatility: 0,
    p50Latency: null,
    p95Latency: null,
    availability: null,
    sampleCount: 0,
    history: [],
    hasData: false,
  }
}

function average(values: number[]): number {
  if (!values.length)
    return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number {
  const weightedValues = values.filter(item => item.weight > 0)
  const totalWeight = weightedValues.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight)
    return 0

  return weightedValues.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function summarizeTaskRecords(records: PingRecord[]): Map<number, TaskRecordSummary> {
  const summaries = new Map<number, TaskRecordSummary>()

  for (const record of records) {
    const summary = summaries.get(record.task_id) ?? { total: 0, success: 0 }
    summary.total += 1
    if (record.value >= 0) {
      summary.success += 1
    }
    summaries.set(record.task_id, summary)
  }

  return summaries
}

function getIncludedTaskIds(records: PingRecord[]): Set<number> {
  const recordSummaries = summarizeTaskRecords(records)

  return new Set(
    [...recordSummaries.entries()]
      .filter(([, summary]) => summary.total > 0)
      .map(([taskId]) => taskId),
  )
}

function normalizeTaskFilter(value: string): string {
  return value.toLowerCase().replace(TASK_FILTER_SEPARATOR_PATTERN, '')
}

function getCacheKey(uuid: string, hours: number, maxCount?: number, taskNameFilter = ''): string {
  return `${CACHE_KEY_PREFIX}:${uuid}:${hours}:${maxCount ?? 'all'}:${normalizeTaskFilter(taskNameFilter) || 'all'}`
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

function readStatsCache(uuid: string, hours: number, maxCount?: number, taskNameFilter = ''): NodePingStatsState | null {
  if (typeof window === 'undefined')
    return null

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter)
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

function writeStatsCache(uuid: string, hours: number, maxCount: number | undefined, value: NodePingStatsState, taskNameFilter = ''): void {
  if (typeof window === 'undefined')
    return

  try {
    const key = getCacheKey(uuid, hours, maxCount, taskNameFilter)
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
        const records = await loadPingRecords(hours, maxCount, nodeUuid)
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

function refreshPingGroupByKey(key: string): void {
  const group = pingRefreshGroups.get(key)
  if (group)
    refreshPingGroup(group)
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
    timer: setInterval(refreshPingGroupByKey, PING_RECORD_REFRESH_INTERVAL_MS, key),
  }
  pingRefreshGroups.set(key, group)
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
  clearInterval(group.timer)
  pingRefreshGroups.delete(groupKey)
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

function buildPingHistory(records: PingRecord[], metricLossPoints?: MetricLossPoint[]): NodePingHistoryPoint[] {
  const sortedRecords = records
    .map((record) => {
      const timestamp = new Date(record.time).getTime()
      return { ...record, timestamp }
    })
    .filter(record => Number.isFinite(record.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
  const sortedMetricLossPoints = (metricLossPoints ?? [])
    .map(point => ({ ...point, timestamp: new Date(point.time).getTime() }))
    .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.count > 0)
    .sort((left, right) => left.timestamp - right.timestamp)

  if (!sortedRecords.length && !sortedMetricLossPoints.length)
    return []

  const firstTime = Math.min(
    sortedRecords[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    sortedMetricLossPoints[0]?.timestamp ?? Number.POSITIVE_INFINITY,
  )
  const lastTime = Math.max(
    sortedRecords.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
    sortedMetricLossPoints.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
  )
  const bucketCount = Math.min(HISTORY_BUCKET_COUNT, Math.max(sortedRecords.length, sortedMetricLossPoints.length))
  const bucketSize = Math.max(1, (lastTime - firstTime) / bucketCount)

  const history: NodePingHistoryPoint[] = []
  let recordIndex = 0
  let metricLossPointIndex = 0

  for (let index = 0; index < bucketCount; index++) {
    const startTime = firstTime + bucketSize * index
    const endTime = index === bucketCount - 1 ? lastTime + 1 : startTime + bucketSize
    let totalCount = 0
    let lostCount = 0
    let latencySum = 0
    let latencyCount = 0
    let metricLossSum = 0
    let metricLossCount = 0

    while (recordIndex < sortedRecords.length) {
      const record = sortedRecords[recordIndex]
      if (!record || record.timestamp >= endTime)
        break

      if (record.timestamp >= startTime) {
        totalCount += 1
        if (record.value >= 0) {
          latencySum += record.value
          latencyCount += 1
        }
        else {
          lostCount += 1
        }
      }
      recordIndex += 1
    }

    while (metricLossPointIndex < sortedMetricLossPoints.length) {
      const point = sortedMetricLossPoints[metricLossPointIndex]
      if (!point || point.timestamp >= endTime)
        break

      if (point.timestamp >= startTime) {
        metricLossSum += point.value * point.count
        metricLossCount += point.count
      }
      metricLossPointIndex += 1
    }

    history.push({
      time: new Date(startTime).toISOString(),
      latency: latencyCount ? latencySum / latencyCount : null,
      loss: metricLossPoints
        ? (metricLossCount ? metricLossSum / metricLossCount * 100 : null)
        : (totalCount ? lostCount / totalCount * 100 : null),
    })
  }

  return history
}

function getPercentile(values: number[], percentile: number): number | null {
  if (!values.length)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentile))
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = sorted[lowerIndex]
  const upperValue = sorted[upperIndex]

  if (lowerValue === undefined || upperValue === undefined)
    return null
  if (lowerIndex === upperIndex)
    return lowerValue

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex)
}

function availabilityFromLoss(loss: number, hasSamples: boolean): number | null {
  return hasSamples ? Math.max(0, Math.min(100, 100 - loss)) : null
}

function metricLossPercent(points?: MetricLossPoint[]): number | null {
  if (!points?.length)
    return null
  return weightedAverage(points.map(point => ({ value: point.value * 100, weight: point.count })))
}

function buildStats(records: PingRecord[], metricStats?: PingMetricTaskStats[], metricLossPoints?: MetricLossPoint[]): NodePingStatsState {
  const statsWithSamples = (metricStats ?? []).filter(stat => stat.total > 0)
  if (statsWithSamples.length) {
    const history = buildPingHistory(records.filter(record => record.value >= 0), metricLossPoints)
    const latencyValues = statsWithSamples
      .flatMap(stat => stat.valid > 0 && isFiniteNumber(stat.avg)
        ? [{ value: stat.avg, weight: stat.valid }]
        : [])
    const latestLatencyValues = statsWithSamples
      .map(stat => stat.latest)
      .filter(isFiniteNumber)
    const lossValues = statsWithSamples
      .filter(stat => !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => ({ value: stat.loss, weight: stat.total }))
    const volatilityValues = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99_p50_ratio))
      .map(stat => ({ value: stat.p99_p50_ratio!, weight: stat.valid }))

    const metricLoss = metricLossPercent(metricLossPoints)
    const avgLoss = lossValues.length ? weightedAverage(lossValues) : (metricLoss ?? 0)
    const recordLatencies = records
      .map(record => record.value)
      .filter(value => value >= 0 && Number.isFinite(value))
    const p50Values = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p50))
      .map(stat => ({ value: stat.p50!, weight: stat.valid }))
    const p99Values = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99))
      .map(stat => ({ value: stat.p99!, weight: stat.valid }))
    const sampleCount = statsWithSamples.reduce((sum, stat) => sum + stat.total, 0)

    return {
      avgLatency: latencyValues.length ? weightedAverage(latencyValues) : average(latestLatencyValues),
      avgLoss,
      avgVolatility: weightedAverage(volatilityValues),
      p50Latency: getPercentile(recordLatencies, 0.5) ?? (p50Values.length ? weightedAverage(p50Values) : null),
      p95Latency: getPercentile(recordLatencies, 0.95) ?? (p99Values.length ? weightedAverage(p99Values) : null),
      availability: availabilityFromLoss(avgLoss, sampleCount > 0),
      sampleCount,
      history,
      hasData: true,
    }
  }

  const includedTaskIds = getIncludedTaskIds(records)

  if (!includedTaskIds.size)
    return createEmptyStats()

  const filteredRecords = records.filter(record => includedTaskIds.has(record.task_id))
  const history = buildPingHistory(filteredRecords)
  const taskRecords = new Map<number, PingRecord[]>()

  for (const record of filteredRecords) {
    const currentRecords = taskRecords.get(record.task_id) ?? []
    currentRecords.push(record)
    taskRecords.set(record.task_id, currentRecords)
  }

  const latencyValues: number[] = []
  const taskLossValues: number[] = []
  const volatilityValues: number[] = []

  for (const recordsByTask of taskRecords.values()) {
    const validValues = recordsByTask
      .map(record => record.value)
      .filter(value => value >= 0)

    taskLossValues.push((recordsByTask.length - validValues.length) / recordsByTask.length * 100)

    if (!validValues.length)
      continue

    latencyValues.push(average(validValues))

    if (validValues.length > 1) {
      const p50 = getPercentile(validValues, 0.5)
      const p99 = getPercentile(validValues, 0.99)
      if (isFiniteNumber(p50) && isFiniteNumber(p99) && p50 > FULL_LOSS_EPSILON) {
        volatilityValues.push(p99 / p50)
      }
    }
  }

  const historyLatencyValues = history
    .map(point => point.latency)
    .filter(isFiniteNumber)
  const historyLossValues = history
    .map(point => point.loss)
    .filter(isFiniteNumber)

  const avgLatency = latencyValues.length ? average(latencyValues) : average(historyLatencyValues)
  const metricLoss = metricLossPercent(metricLossPoints)
  const avgLoss = metricLoss ?? (taskLossValues.length ? average(taskLossValues) : average(historyLossValues))
  const avgVolatility = average(volatilityValues)
  const hasData = history.length > 0 || latencyValues.length > 0 || taskLossValues.length > 0
  const validLatencyValues = filteredRecords
    .map(record => record.value)
    .filter(value => value >= 0 && Number.isFinite(value))

  return {
    avgLatency,
    avgLoss,
    avgVolatility,
    p50Latency: getPercentile(validLatencyValues, 0.5),
    p95Latency: getPercentile(validLatencyValues, 0.95),
    availability: availabilityFromLoss(avgLoss, filteredRecords.length > 0),
    sampleCount: filteredRecords.length,
    history,
    hasData,
  }
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
    taskNameFilter?: MaybeRefOrGetter<string>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    const taskNameFilter = toValue(options?.taskNameFilter)?.trim() ?? ''
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedPingRecordsKey(hours, maxCount, toValue(uuid)),
      taskNameFilter,
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
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return createEmptyStats()

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state)
      return readStatsCache(nodeUuid, hours, maxCount, taskNameFilter) ?? createEmptyStats()

    const normalizedFilter = normalizeTaskFilter(taskNameFilter)
    const matchingTaskIds = normalizedFilter
      ? new Set([...state.taskNamesById.entries()]
          .filter(([, name]) => normalizeTaskFilter(name).includes(normalizedFilter))
          .map(([taskId]) => taskId))
      : null
    const records = (state.recordsByClient.get(nodeUuid) ?? [])
      .filter(record => !matchingTaskIds || matchingTaskIds.has(record.task_id))
    const metricStats = state.metricStats?.filter(stat => !matchingTaskIds || matchingTaskIds.has(normalizeTaskId(stat.task_id)))
    const metricLossPoints = state.metricLossPoints?.filter(point => !matchingTaskIds || matchingTaskIds.has(point.taskId))
    return records.length || metricStats?.length
      ? buildStats(records, metricStats, metricLossPoints)
      : createEmptyStats()
  })

  const taskNames = computed<string[]>(() => {
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return []

    const state = getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value
    if (!state)
      return []

    const normalizedFilter = normalizeTaskFilter(taskNameFilter)
    return [...new Set([...state.taskNamesById.values()]
      .filter(name => !normalizedFilter || normalizeTaskFilter(name).includes(normalizedFilter)))]
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
    (nodeUuid: string, hours: number, maxCount: number | undefined, taskNameFilter: string, value: NodePingStatsState) => {
      writeStatsCache(nodeUuid, hours, maxCount, value, taskNameFilter)
    },
    30_000,
    true,
    true,
  )

  watch(stats, (value) => {
    if (!value.hasData)
      return
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, enabled } = resolved.value
    if (enabled && nodeUuid.trim())
      persistStats(nodeUuid, hours, maxCount, taskNameFilter, value)
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
