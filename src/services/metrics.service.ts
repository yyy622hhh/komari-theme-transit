import type { MetricDefinition, MetricQueryParams, MetricQueryResponse, PingMetricStatsParams, PingMetricStatsResponse, PingTaskInfo } from '@/utils/rpc'
import { CACHE_CONFIG } from '@/constants/cache'
import { REQUEST_CONFIG } from '@/constants/request'
import { SharedCache } from '@/services/cache.service'
import { requestManager } from '@/services/request.service'
import { getSharedRpc, isRpcPermissionError, RpcError } from '@/utils/rpc'

function normalizeHours(hours: number | null | undefined): number | undefined {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)
    return undefined
  return Math.max(1, Math.floor(hours))
}

function normalizeMaxPoints(maxPoints: number | null | undefined): number | undefined {
  if (typeof maxPoints !== 'number' || !Number.isFinite(maxPoints) || maxPoints <= 0)
    return undefined
  return Math.floor(maxPoints)
}

function cachePart(value: unknown): string {
  if (value === undefined)
    return 'undefined'
  if (value === null)
    return 'null'
  if (typeof value !== 'object')
    return `${typeof value}:${String(value)}`

  const stabilize = (item: unknown): unknown => {
    if (Array.isArray(item))
      return item.map(stabilize)
    if (!item || typeof item !== 'object')
      return item
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, stabilize(nestedValue)]),
    )
  }

  try {
    return `json:${JSON.stringify(stabilize(value))}`
  }
  catch {
    return String(value)
  }
}

function shouldRetryMetricRequest(error: unknown): boolean {
  if (error instanceof RpcError)
    return !isRpcPermissionError(error) && error.code !== -32601
  return true
}

function normalizeMetricKeys(params: MetricQueryParams): string[] {
  const keys = [
    ...(params.metric_keys ?? []),
    ...(params.metrics ?? []),
    ...(params.metric_key ? [params.metric_key] : []),
  ]
  return [...new Set(keys.filter(Boolean))].sort()
}

const metricDefinitionsCache = new SharedCache<MetricDefinition[]>({
  maxSize: 1,
  ttl: CACHE_CONFIG.request.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

const publicPingTasksCache = new SharedCache<PingTaskInfo[]>({
  maxSize: CACHE_CONFIG.publicPingTasks.maxSize,
  ttl: CACHE_CONFIG.publicPingTasks.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

export function getMetricDefinitionsRequestKey(): string {
  return 'metrics:definitions'
}

export function getQueryMetricsRequestKey(params: MetricQueryParams): string {
  return `metrics:query:${cachePart({
    ...params,
    metric_key: undefined,
    metric_keys: normalizeMetricKeys(params),
    metrics: undefined,
  })}`
}

export function getPingMetricStatsRequestKey(params: PingMetricStatsParams): string {
  return [
    'metrics:ping-stats',
    cachePart(params.uuid ?? params.entity_id),
    cachePart(params.entity_ids),
    cachePart(params.task_id),
    cachePart(params.task_ids),
    cachePart(params.hours),
    cachePart(params.start ?? params.start_time),
    cachePart(params.end ?? params.end_time),
    cachePart(params.max_points ?? params.downsample_points),
  ].join(':')
}

export function getPublicPingTasksRequestKey(): string {
  return 'metrics:public-ping-tasks'
}

export function partitionMetricEntityIds(
  entityIds: string[],
  batchSize = REQUEST_CONFIG.metrics.entityBatchSize,
): string[][] {
  const safeBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 1
  const normalized = [...new Set(entityIds.map(entityId => entityId.trim()).filter(Boolean))]
  const batches: string[][] = []
  for (let index = 0; index < normalized.length; index += safeBatchSize)
    batches.push(normalized.slice(index, index + safeBatchSize))
  return batches
}

export function abortQueryMetrics(params: MetricQueryParams): void {
  requestManager.abort(getQueryMetricsRequestKey(params))
}

export function abortPingMetricStats(params: PingMetricStatsParams): void {
  requestManager.abort(getPingMetricStatsRequestKey(params))
}

export async function loadMetricDefinitions(): Promise<MetricDefinition[]> {
  const key = getMetricDefinitionsRequestKey()
  const cached = metricDefinitionsCache.get(key)
  if (cached)
    return cached

  const definitions = await requestManager.run(
    key,
    async () => getSharedRpc().listPublicMetricDefinitions(),
    { shouldRetry: shouldRetryMetricRequest },
  )
  return metricDefinitionsCache.set(key, definitions)
}

export async function queryMetrics(params: MetricQueryParams): Promise<MetricQueryResponse> {
  const normalizedParams: MetricQueryParams = {
    ...params,
    hours: normalizeHours(params.hours),
    max_points: normalizeMaxPoints(params.max_points ?? params.downsample_points),
  }

  return requestManager.run(
    getQueryMetricsRequestKey(normalizedParams),
    async signal => getSharedRpc().queryPublicMetrics(normalizedParams, signal),
    { shouldRetry: shouldRetryMetricRequest },
  )
}

export async function loadPingMetricStats(params: PingMetricStatsParams): Promise<PingMetricStatsResponse> {
  const normalizedParams: PingMetricStatsParams = {
    ...params,
    hours: normalizeHours(params.hours),
    max_points: normalizeMaxPoints(params.max_points ?? params.downsample_points),
  }

  return requestManager.run(
    getPingMetricStatsRequestKey(normalizedParams),
    async signal => getSharedRpc().getPublicPingMetricStats(normalizedParams, signal),
    { shouldRetry: shouldRetryMetricRequest },
  )
}

export async function loadPublicPingTasks(): Promise<PingTaskInfo[]> {
  const key = getPublicPingTasksRequestKey()
  const cached = publicPingTasksCache.get(key)
  if (cached)
    return cached

  const tasks = await requestManager.run(
    key,
    async () => getSharedRpc().getPublicPingTasks(),
    { shouldRetry: shouldRetryMetricRequest },
  )
  return publicPingTasksCache.set(key, tasks)
}

export function invalidatePublicPingTasksCache(): void {
  publicPingTasksCache.clear()
}

export async function loadPingTaskNamesForNode(nodeUuid: string): Promise<string[]> {
  if (!nodeUuid.trim())
    return []

  const [tasksResult, statsResult] = await Promise.allSettled([
    loadPublicPingTasks(),
    loadPingMetricStats({ entity_id: nodeUuid, hours: 1, max_points: 1 }),
  ])
  if (tasksResult.status === 'rejected' && statsResult.status === 'rejected')
    throw new Error('无法读取 Ping 任务，请稍后重试。')

  const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : []
  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null
  const taskById = new Map(tasks.map(task => [String(task.id), task.name]))
  const configuredTaskNames = tasks
    // Komari 1.4 stores `default_on` (legacy JSON name `all_clients`) only as
    // the default for newly registered nodes. Runtime scheduling uses the
    // explicit clients array, so an empty/default-on task is not global.
    .filter(task => task.clients?.includes(nodeUuid))
    .map(task => task.name.trim())
    .filter(Boolean)
  const observedTaskNames = (stats?.stats ?? [])
    .filter(stat => stat.entity_id === nodeUuid)
    .map(stat => stat.name?.trim() || taskById.get(String(stat.task_id))?.trim() || '')
    .filter(Boolean)
  return [...new Set([...configuredTaskNames, ...observedTaskNames])]
}
