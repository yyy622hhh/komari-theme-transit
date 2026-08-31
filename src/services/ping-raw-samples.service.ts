import type { PingRecord } from '@/utils/rpc'
import { partitionMetricEntityIds, queryMetrics } from '@/services/metrics.service'
import { PING_LATENCY_METRIC, PING_LOSS_METRIC } from '@/utils/metricSeries'
import { normalizeRawPingSamples, rawPingSamplesFromMetrics } from '@/utils/pingCurrentState'

// Komari 1.4.3 retains exact samples for ten minutes. Keep one minute of margin
// for rounding/transport; the legacy records API returns rollups, not raw proof.
export function rawPingQueryStart(since: number, now: number): number {
  return Math.max(since, Math.floor(now / 60_000) * 60_000 - 8 * 60_000)
}

export async function loadRawPingSamples(clients: readonly string[], since: number, taskId?: number): Promise<PingRecord[]> {
  if (!clients.length)
    return []
  const allowed = new Set(clients)
  const start = rawPingQueryStart(since, Date.now())
  const filter = (records: PingRecord[]) => normalizeRawPingSamples(records.filter(record => allowed.has(record.client) && (taskId === undefined || record.task_id === taskId)), since, Date.now())
  try {
    const responses = await Promise.all(partitionMetricEntityIds([...allowed].sort()).map(entity_ids => queryMetrics({
      entity_ids,
      metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
      start: new Date(start).toISOString(),
      downsample: false,
      fill_empty: false,
      max_points: 1000,
      ...(taskId === undefined ? {} : { tags: { task_id: String(taskId) } }),
    })))
    const series = responses.flatMap(response => response.series)
    if (series.some(item => item.downsampled !== false))
      throw new Error('Raw samples unavailable')
    return filter(rawPingSamplesFromMetrics(series))
  }
  catch {
    throw new Error('无法取得精确原始样本；汇总值不能用于当前状态或候选验证。请稍后重试或检查 Komari 原始指标支持。')
  }
}
