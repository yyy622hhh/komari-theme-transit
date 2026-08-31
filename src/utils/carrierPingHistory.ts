import type { NodePingHistoryPoint } from '@/utils/pingStats'

/**
 * Regional windows may start/end at different times after migration or outages.
 * Align timestamps, never the nth array element (which can mix an old outage into now).
 */
export function mergeCarrierPingHistory(histories: readonly NodePingHistoryPoint[][]): NodePingHistoryPoint[] {
  const nonempty = histories.filter(history => history.length)
  if (nonempty.length <= 1)
    return nonempty[0] ?? []
  const points = nonempty.flat().map(point => ({ ...point, at: Date.parse(point.time) })).filter(point => Number.isFinite(point.at))
  if (!points.length)
    return []
  const start = Math.min(...points.map(point => point.at))
  const end = Math.max(...points.map(point => point.at))
  const count = Math.min(20, new Set(points.map(point => point.at)).size)
  const width = Math.max(1, (end - start) / count)
  const buckets = Array.from({ length: count }, () => ({ latency: 0, latencyCount: 0, loss: 0, lossCount: 0 }))
  for (const point of points) {
    const bucket = buckets[Math.min(count - 1, Math.floor((point.at - start) / width))]!
    if (point.latency !== null && Number.isFinite(point.latency)) {
      bucket.latency += point.latency
      bucket.latencyCount++
    }
    if (point.loss !== null && Number.isFinite(point.loss)) {
      bucket.loss += point.loss
      bucket.lossCount++
    }
  }
  return buckets.map((bucket, index) => ({
    time: new Date(start + index * width).toISOString(),
    latency: bucket.latencyCount ? bucket.latency / bucket.latencyCount : null,
    loss: bucket.lossCount ? bucket.loss / bucket.lossCount : null,
  }))
}
