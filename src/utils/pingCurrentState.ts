import type { MetricSeries, PingRecord } from '@/utils/rpc'
import { OPS_ALERT_THRESHOLDS } from '@/constants/ops'
import { normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'

export type ProbeCurrentStatus = 'healthy' | 'failed' | 'intermittent' | 'insufficient' | 'stale' | 'offline'
export interface ProbeCurrentState {
  status: ProbeCurrentStatus
  sampleCount: number
  latestAt: number | null
  lastSuccessAt: number | null
}

export const PROBE_CURRENT_LABELS: Record<ProbeCurrentStatus, string> = {
  healthy: '正常',
  failed: '持续失败',
  intermittent: '间歇失败',
  insufficient: '证据不足',
  stale: '数据过期',
  offline: '来源离线',
}

/** Historical failures never establish current failure or recovery on their own. */
export function formatProbeCurrentLabel(status: ProbeCurrentStatus, historicalFailure = false): string {
  return `${PROBE_CURRENT_LABELS[status]}${status === 'healthy' && historicalFailure ? '（已恢复）' : ''}`
}

export function formatProbeCurrentCompactLabel(status: ProbeCurrentStatus, historicalFailure = false): string {
  return status === 'healthy' && historicalFailure ? '已恢复' : PROBE_CURRENT_LABELS[status]
}

export function probeCurrentTone(status: ProbeCurrentStatus): string {
  if (status === 'healthy')
    return 'text-emerald-700 dark:text-emerald-300'
  if (status === 'failed')
    return 'text-rose-700 dark:text-rose-300'
  if (status === 'intermittent')
    return 'text-amber-800 dark:text-amber-300'
  return 'text-slate-600 dark:text-slate-300'
}

export function probeFailureRateLabel(type: string): string {
  return type === 'icmp' ? 'ICMP 丢包率' : '探测失败率'
}

export function probeSampleFreshnessMs(interval = 30): number {
  return Math.max(3 * (Number.isFinite(interval) && interval > 0 ? interval : 30) * 1000, 180_000)
}

/** A conflicting duplicate is a failure, never evidence for consecutive success. */
export function normalizeRawPingSamples(records: readonly PingRecord[], since = 0, now = Date.now()): PingRecord[] {
  const unique = new Map<string, PingRecord>()
  for (const record of records) {
    const time = Date.parse(record.time)
    if (!Number.isFinite(time) || time < since || time > now || !Number.isFinite(record.value))
      continue
    const key = `${record.client}:${record.task_id}:${time}`
    const previous = unique.get(key)
    unique.set(key, { ...record, time: new Date(time).toISOString(), value: previous && previous.value < 0 ? previous.value : record.value })
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/** Aggregated or filled points must never prove an individual probe succeeded. */
export function rawPingSamplesFromMetrics(series: readonly MetricSeries[]): PingRecord[] {
  const records: PingRecord[] = []
  for (const item of normalizeMetricSeriesList([...series])) {
    const id = Number(pingTaskId(item))
    if (item.downsampled !== false || !Number.isInteger(id) || id <= 0)
      continue
    if (item.metric_key !== PING_LATENCY_METRIC && item.metric_key !== PING_LOSS_METRIC)
      continue
    for (const point of item.points) {
      if (typeof point.value !== 'number' || (point.count !== undefined && point.count !== 1))
        continue
      if (item.metric_key === PING_LOSS_METRIC && point.value !== 0 && point.value !== 1 && point.value !== 100)
        continue
      records.push({ client: item.entity_id, task_id: id, time: point.time, value: item.metric_key === PING_LOSS_METRIC ? (point.value > 0 ? -1 : 0) : point.value })
    }
  }
  return normalizeRawPingSamples(records)
}

export function resolveProbeCurrentState(records: readonly PingRecord[], options: { now?: number, interval?: number, online?: boolean } = {}): ProbeCurrentState {
  const now = options.now ?? Date.now()
  const samples = normalizeRawPingSamples(records, 0, now)
  const latestAt = samples.length ? Date.parse(samples.at(-1)!.time) : null
  const success = [...samples].reverse().find(record => record.value >= 0)
  const lastSuccessAt = success ? Date.parse(success.time) : null
  const recent = samples.filter(record => now - Date.parse(record.time) <= probeSampleFreshnessMs(options.interval)).slice(-3)
  let status: ProbeCurrentStatus = 'insufficient'
  if (options.online === false)
    status = 'offline'
  else if (latestAt !== null && now - latestAt > probeSampleFreshnessMs(options.interval))
    status = 'stale'
  else if (recent.length >= 3)
    status = recent.every(record => record.value >= 0) ? 'healthy' : recent.every(record => record.value < 0) ? 'failed' : 'intermittent'
  return { status, sampleCount: recent.length, latestAt, lastSuccessAt }
}

/** Different tasks must be evaluated independently, never stitched into one streak. */
export function mergeProbeCurrentStates(states: readonly ProbeCurrentState[]): ProbeCurrentState {
  const priority: ProbeCurrentStatus[] = ['offline', 'failed', 'intermittent', 'stale', 'insufficient', 'healthy']
  const status = priority.find(value => states.some(state => state.status === value)) ?? 'insufficient'
  return {
    status,
    sampleCount: states.reduce((sum, state) => sum + state.sampleCount, 0),
    latestAt: Math.max(0, ...states.map(state => state.latestAt ?? 0)) || null,
    lastSuccessAt: Math.max(0, ...states.map(state => state.lastSuccessAt ?? 0)) || null,
  }
}

export function hasCurrentCommonModeFailure(records: readonly PingRecord[], clients: readonly string[], interval: number, now: number): boolean {
  const failed = clients.filter(client => resolveProbeCurrentState(records.filter(record => record.client === client), { interval, now }).status === 'failed')
  const { minAffectedNodes, minAffectedRatio } = OPS_ALERT_THRESHOLDS.carrierCommonMode
  if (failed.length < minAffectedNodes)
    return false
  const buckets = new Map<number, { observed: Set<string>, failed: Set<string> }>()
  for (const record of normalizeRawPingSamples(records, now - probeSampleFreshnessMs(interval), now)) {
    if (!clients.includes(record.client))
      continue
    const bucket = Math.floor(Date.parse(record.time) / (Math.max(1, interval || 30) * 1000))
    const entry = buckets.get(bucket) ?? { observed: new Set<string>(), failed: new Set<string>() }
    entry.observed.add(record.client)
    if (record.value < 0 && failed.includes(record.client))
      entry.failed.add(record.client)
    buckets.set(bucket, entry)
  }
  return [...buckets.values()].some(entry => entry.failed.size >= minAffectedNodes && entry.failed.size / entry.observed.size >= minAffectedRatio)
}
