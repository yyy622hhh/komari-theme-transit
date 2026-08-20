import type { MetricSeries } from '@/utils/rpc'
import { OPS_ALERT_THRESHOLDS } from '@/constants/ops'
import { normalizeMetricSeriesList, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'

interface CommonModeObservation {
  observedNodes: Set<string>
  affectedNodes: Set<string>
}

function observationKey(taskId: string, time: string): string {
  const timestamp = Date.parse(time)
  return `${taskId}:${Number.isFinite(timestamp) ? timestamp : time}`
}

export function getPingCommonModeLossKey(taskId: string | number, time: string): string {
  return observationKey(String(taskId), time)
}

/**
 * 找出同一任务、同一时间桶内多数节点同步失败的采样。
 *
 * 这种共同失败更像探测目标拒绝连接、限流或短暂不可达，而不是每台节点各自的
 * 线路同时坏掉。这里只标记事实，原始丢包仍然保留给界面展示和历史追溯。
 */
export function detectPingCommonModeLossKeys(seriesList: readonly MetricSeries[]): Set<string> {
  const observations = new Map<string, CommonModeObservation>()

  for (const series of normalizeMetricSeriesList([...seriesList])) {
    if (series.metric_key !== PING_LOSS_METRIC || !series.entity_id.trim())
      continue
    const taskId = pingTaskId(series)
    if (!taskId)
      continue

    for (const point of series.points) {
      if (typeof point.value !== 'number' || !Number.isFinite(point.value))
        continue
      if (typeof point.count === 'number' && (!Number.isFinite(point.count) || point.count <= 0))
        continue

      const key = observationKey(taskId, point.time)
      const observation = observations.get(key) ?? {
        observedNodes: new Set<string>(),
        affectedNodes: new Set<string>(),
      }
      observation.observedNodes.add(series.entity_id)
      if (point.value > 0)
        observation.affectedNodes.add(series.entity_id)
      observations.set(key, observation)
    }
  }

  return new Set([...observations.entries()]
    .filter(([, observation]) => (
      observation.affectedNodes.size >= OPS_ALERT_THRESHOLDS.carrierCommonMode.minAffectedNodes
      && observation.affectedNodes.size / observation.observedNodes.size
      >= OPS_ALERT_THRESHOLDS.carrierCommonMode.minAffectedRatio
    ))
    .map(([key]) => key))
}
