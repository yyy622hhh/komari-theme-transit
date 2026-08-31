import type { MetricQueryResponse, PingMetricStatsResponse, PingRecord } from '@/utils/rpc'
import { loadPingMetricStats, partitionMetricEntityIds, queryMetrics } from '@/services/metrics.service'
import { loadRawPingSamples } from '@/services/ping-raw-samples.service'
import { PING_LATENCY_METRIC, PING_LOSS_METRIC } from '@/utils/metricSeries'
import { detectPingCommonModeLossKeys } from '@/utils/pingCommonMode'

interface PingMetricBatchResult {
  stats: PingMetricStatsResponse | null
  metrics: MetricQueryResponse | null
  raw: PingRecord[]
  commonModeKeys: ReadonlySet<string>
}
interface PendingBatch {
  hours: number
  maxCount?: number
  uuids: Map<string, Array<(value: PingMetricBatchResult | null) => void>>
}
const pending = new Map<string, PendingBatch>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validStats(value: unknown): value is PingMetricStatsResponse {
  return record(value) && Array.isArray(value.stats) && value.stats.every(item => record(item)
    && typeof item.entity_id === 'string' && typeof item.task_id === 'string'
    && typeof item.total === 'number' && Number.isFinite(item.total)
    && typeof item.valid === 'number' && Number.isFinite(item.valid))
}

function validMetrics(value: unknown): value is MetricQueryResponse {
  return record(value) && Array.isArray(value.series) && value.series.every(item => record(item)
    && typeof item.entity_id === 'string' && typeof item.metric_key === 'string'
    && Array.isArray(item.points) && item.points.every(point => record(point)
      && typeof point.time === 'string' && Number.isFinite(Date.parse(point.time))
      && (point.value === null || (typeof point.value === 'number' && Number.isFinite(point.value)))))
}

async function flush(key: string, batch: PendingBatch): Promise<void> {
  pending.delete(key)
  try {
    const groups = await Promise.all(partitionMetricEntityIds([...batch.uuids.keys()]).map(async (entityIds) => {
      const [stats, metrics, raw] = await Promise.allSettled([
        loadPingMetricStats({ entity_ids: entityIds, hours: batch.hours, max_points: batch.maxCount }),
        queryMetrics({ metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC], entity_ids: entityIds, hours: batch.hours, downsample: true, fill_empty: true, max_points: batch.maxCount, aggregation: 'avg' }),
        loadRawPingSamples(entityIds, Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000),
      ])
      return {
        entityIds,
        stats: stats.status === 'fulfilled' && validStats(stats.value) ? stats.value : null,
        metrics: metrics.status === 'fulfilled' && validMetrics(metrics.value) ? metrics.value : null,
        raw: raw.status === 'fulfilled' ? raw.value : [],
      }
    }))
    // Transport partitioning must not alter the fleet-level failure denominator.
    const commonModeKeys = groups.every(group => group.metrics !== null)
      ? detectPingCommonModeLossKeys(groups.flatMap(group => group.metrics?.series ?? []))
      : new Set<string>()
    for (const group of groups) {
      for (const uuid of group.entityIds)
        batch.uuids.get(uuid)?.forEach(resolve => resolve({ ...group, commonModeKeys }))
    }
  }
  catch {
    // Always settle every consumer, including unexpected parsing failures.
    // The caller can fall back to legacy history and retry on its next refresh.
    batch.uuids.forEach(resolvers => resolvers.forEach(resolve => resolve(null)))
  }
}

export function loadPingMetricBatch(uuid: string, hours: number, maxCount?: number): Promise<PingMetricBatchResult | null> {
  const key = `${hours}:${maxCount ?? 'all'}`
  let batch = pending.get(key)
  if (!batch) {
    batch = { hours, maxCount, uuids: new Map() }
    pending.set(key, batch)
    const scheduled = batch
    queueMicrotask(() => {
      void flush(key, scheduled)
    })
  }
  return new Promise((resolve) => {
    const resolvers = batch.uuids.get(uuid) ?? []
    resolvers.push(resolve)
    batch.uuids.set(uuid, resolvers)
  })
}
