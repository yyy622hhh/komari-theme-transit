import type { PingFreshness } from '@/utils/pingFreshness'
import type { MetricLossPoint } from '@/utils/pingStats'
import type { PingRecord } from '@/utils/rpc'

const HOUR_MS = 60 * 60 * 1000
const BEIJING_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  hour12: false,
  timeZone: 'Asia/Shanghai',
})

export interface TopologyInsightPoint {
  at: number
  taskId: number
  latency: number | null
  loss: number | null
}

export interface TopologyHourlyBucket {
  hour: number
  latencyMedian: number | null
  lossMedian: number | null
  sampleCount: number
}

export interface TopologyBaselineShift {
  at: number
  beforeMedian: number
  afterMedian: number
  deltaMs: number
  deltaPercent: number
  direction: 'degraded' | 'improved'
}

export interface TopologyInsightCoverage {
  from: number | null
  to: number | null
  sampleCount: number
  stale: boolean
}

export interface TopologyInsightBaseline {
  latencyP50: number | null
  latencyP95: number | null
  lossMedian: number | null
  sampleCount: number
}

export interface TopologyInsightEvidence {
  currentLatency: number | null
  currentLoss: number | null
  baselineLatencyP50: number | null
  baselineLatencyP95: number | null
  baselineLossMedian: number | null
  baselineSampleCount: number
  latestSampleAt: number | null
  freshness: PingFreshness
  dayCoverage: TopologyInsightCoverage
  weekCoverage: TopologyInsightCoverage
}

export interface TopologyPeakInsight {
  status: 'degraded' | 'stable'
  peakLatencyMedian: number | null
  normalLatencyMedian: number | null
  latencyDeltaMs: number | null
  latencyDeltaPercent: number | null
  peakLossMedian: number | null
  normalLossMedian: number | null
  lossDeltaPoints: number | null
  worstHour: number | null
  validPeakHours: number
  validNormalHours: number
}

export type TopologyDiagnosisKind = 'latency' | 'loss' | 'both'

export interface TopologyDiagnosis {
  kind: TopologyDiagnosisKind
  message: string
  baselineLatency: number
  baselineLoss: number
}

export interface TopologyPairCandidate {
  routeKey: string
  sourceUuid: string
  targetUuid: string
  live: boolean
}

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

export function median(values: Array<number | null | undefined>): number | null {
  const sorted = finite(values).sort((left, right) => left - right)
  if (!sorted.length)
    return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length)
    return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * fraction))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper)
    return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function insightPointKey(taskId: number, at: number): string {
  return `${taskId}:${at}`
}

/** Preserve the exact-task series before the normal node-card history is collapsed to 20 buckets. */
export function buildTopologyInsightPoints(
  records: readonly PingRecord[],
  metricLossPoints: readonly MetricLossPoint[] = [],
  taskIds?: ReadonlySet<number> | null,
  limit = 240,
): TopologyInsightPoint[] {
  const points = new Map<string, TopologyInsightPoint>()
  const accept = (taskId: number) => !taskIds || taskIds.has(taskId)

  for (const record of records) {
    const at = Date.parse(record.time)
    if (!accept(record.task_id) || !Number.isFinite(at) || !Number.isFinite(record.value))
      continue
    const key = insightPointKey(record.task_id, at)
    const current = points.get(key) ?? { at, taskId: record.task_id, latency: null, loss: null }
    if (record.value >= 0) {
      current.latency = record.value
      if (!metricLossPoints.length)
        current.loss = 0
    }
    else if (!metricLossPoints.length) {
      current.loss = 100
    }
    points.set(key, current)
  }

  for (const point of metricLossPoints) {
    const at = Date.parse(point.time)
    if (!accept(point.taskId) || !Number.isFinite(at) || !Number.isFinite(point.value))
      continue
    const key = insightPointKey(point.taskId, at)
    const current = points.get(key) ?? { at, taskId: point.taskId, latency: null, loss: null }
    current.loss = Math.max(0, Math.min(100, point.value * 100))
    points.set(key, current)
  }

  const grouped = new Map<number, TopologyInsightPoint[]>()
  for (const point of points.values()) {
    const taskPoints = grouped.get(point.taskId) ?? []
    taskPoints.push(point)
    grouped.set(point.taskId, taskPoints)
  }

  return [...grouped.values()]
    .flatMap(taskPoints => taskPoints.sort((left, right) => left.at - right.at).slice(-limit))
    .sort((left, right) => left.at - right.at)
}

export function getTopologyInsightCoverage(
  points: readonly TopologyInsightPoint[],
  stale = false,
): TopologyInsightCoverage {
  const timestamps = points.map(point => point.at).filter(Number.isFinite)
  return {
    from: timestamps.length ? Math.min(...timestamps) : null,
    to: timestamps.length ? Math.max(...timestamps) : null,
    sampleCount: points.filter(point => point.latency !== null || point.loss !== null).length,
    stale,
  }
}

export function getBeijingHour(timestamp: number): number {
  const parsed = Number.parseInt(BEIJING_HOUR_FORMATTER.format(new Date(timestamp)), 10)
  return parsed === 24 ? 0 : parsed
}

export function bucketTopologyInsightsByBeijingHour(
  points: readonly TopologyInsightPoint[],
  minimumSamples = 3,
): TopologyHourlyBucket[] {
  const hours = Array.from({ length: 24 }, () => [] as TopologyInsightPoint[])
  for (const point of points) {
    if (!Number.isFinite(point.at))
      continue
    hours[getBeijingHour(point.at)]!.push(point)
  }
  return hours.map((items, hour) => {
    const latencies = finite(items.map(item => item.latency))
    const losses = finite(items.map(item => item.loss))
    return {
      hour,
      latencyMedian: latencies.length >= minimumSamples ? median(latencies) : null,
      lossMedian: losses.length >= minimumSamples ? median(losses) : null,
      sampleCount: items.filter(item => item.latency !== null || item.loss !== null).length,
    }
  })
}

/** Build the 24h comparison window once so diagnosis and its visible evidence cannot drift apart. */
export function calculateTopologyInsightBaseline(
  history: readonly TopologyInsightPoint[],
): TopologyInsightBaseline {
  const latestAt = Math.max(...history.map(point => point.at), 0)
  const baselinePoints = latestAt > 0 ? history.filter(point => point.at <= latestAt - HOUR_MS) : []
  const latencies = finite(baselinePoints.map(point => point.latency))
  const losses = finite(baselinePoints.map(point => point.loss))
  return {
    latencyP50: latencies.length >= 12 ? median(latencies) : null,
    latencyP95: latencies.length >= 12 ? percentile(latencies, 0.95) : null,
    lossMedian: losses.length >= 12 ? median(losses) : null,
    sampleCount: baselinePoints.filter(point => point.latency !== null || point.loss !== null).length,
  }
}

export function analyzeTopologyPeakInsight(
  buckets: readonly TopologyHourlyBucket[],
  options: { stale?: boolean, taskId?: number | null } = {},
): TopologyPeakInsight | null {
  if (options.stale || options.taskId === null || options.taskId === undefined)
    return null
  const peak = buckets.filter(bucket => bucket.hour >= 20 && bucket.hour <= 23)
  const normal = buckets.filter(bucket => bucket.hour >= 0 && bucket.hour < 20)
  const validPeakHours = peak.filter(bucket => bucket.latencyMedian !== null || bucket.lossMedian !== null).length
  const validNormalHours = normal.filter(bucket => bucket.latencyMedian !== null || bucket.lossMedian !== null).length
  if (validPeakHours < 3 || validNormalHours < 12)
    return null

  const peakLatencies = finite(peak.map(bucket => bucket.latencyMedian))
  const normalLatencies = finite(normal.map(bucket => bucket.latencyMedian))
  const peakLosses = finite(peak.map(bucket => bucket.lossMedian))
  const normalLosses = finite(normal.map(bucket => bucket.lossMedian))
  const peakLatencyMedian = peakLatencies.length >= 3 ? median(peakLatencies) : null
  const normalLatencyMedian = normalLatencies.length >= 12 ? median(normalLatencies) : null
  const peakLossMedian = peakLosses.length >= 3 ? median(peakLosses) : null
  const normalLossMedian = normalLosses.length >= 12 ? median(normalLosses) : null
  if ((peakLatencyMedian === null || normalLatencyMedian === null)
    && (peakLossMedian === null || normalLossMedian === null)) {
    return null
  }

  const latencyDeltaMs = peakLatencyMedian !== null && normalLatencyMedian !== null
    ? peakLatencyMedian - normalLatencyMedian
    : null
  const latencyDeltaPercent = latencyDeltaMs !== null && normalLatencyMedian !== null && normalLatencyMedian > 0
    ? latencyDeltaMs / normalLatencyMedian * 100
    : null
  const lossDeltaPoints = peakLossMedian !== null && normalLossMedian !== null
    ? peakLossMedian - normalLossMedian
    : null
  const latencyDegraded = latencyDeltaMs !== null && normalLatencyMedian !== null
    && latencyDeltaMs >= Math.max(20, normalLatencyMedian * 0.3)
  const lossDegraded = peakLossMedian !== null && normalLossMedian !== null && lossDeltaPoints !== null
    && peakLossMedian >= 3
    && lossDeltaPoints >= 3
    && (normalLossMedian <= 0 || peakLossMedian >= normalLossMedian * 2)
  const status: TopologyPeakInsight['status'] = latencyDegraded || lossDegraded ? 'degraded' : 'stable'
  const worst = status === 'degraded'
    ? [...peak]
        .filter(bucket => latencyDegraded ? bucket.latencyMedian !== null : bucket.lossMedian !== null)
        .sort((left, right) => latencyDegraded
          ? (right.latencyMedian ?? -1) - (left.latencyMedian ?? -1) || (right.lossMedian ?? -1) - (left.lossMedian ?? -1)
          : (right.lossMedian ?? -1) - (left.lossMedian ?? -1))[0]
    : undefined

  return {
    status,
    peakLatencyMedian,
    normalLatencyMedian,
    latencyDeltaMs,
    latencyDeltaPercent,
    peakLossMedian,
    normalLossMedian,
    lossDeltaPoints,
    worstHour: worst?.hour ?? null,
    validPeakHours,
    validNormalHours,
  }
}

export function describeTopologyPeakInsight(insight: TopologyPeakInsight): string {
  if (insight.status === 'stable')
    return '晚高峰与其他时段未见显著差异。'
  const parts: string[] = []
  if (insight.latencyDeltaMs !== null && insight.latencyDeltaMs > 0)
    parts.push(`晚高峰延迟高 ${Math.round(insight.latencyDeltaMs)} ms`)
  if (insight.lossDeltaPoints !== null && insight.lossDeltaPoints > 0)
    parts.push(`丢包高 ${insight.lossDeltaPoints.toFixed(insight.lossDeltaPoints >= 10 ? 0 : 1)} 个百分点`)
  const summary = parts.join('，') || '晚高峰质量明显变差'
  return insight.worstHour === null ? `${summary}。` : `${summary}，${String(insight.worstHour).padStart(2, '0')}:00 最明显。`
}

export function diagnoseTopologySegment(input: {
  currentLatency: number | null
  currentLoss: number | null
  hasLiveData: boolean
  stale: boolean
  history: readonly TopologyInsightPoint[]
}): TopologyDiagnosis | null {
  if (!input.hasLiveData || input.stale || input.currentLatency === null || input.currentLoss === null)
    return null
  const baseline = calculateTopologyInsightBaseline(input.history)
  const baselineLatency = baseline.latencyP50
  const p95Latency = baseline.latencyP95
  const baselineLoss = baseline.lossMedian
  if (baselineLatency === null || p95Latency === null || baselineLoss === null)
    return null

  const latencyRaised = input.currentLatency > Math.max(baselineLatency * 1.2, p95Latency)
  const lossRaised = input.currentLoss >= 3
    && input.currentLoss - baselineLoss >= 3
    && (baselineLoss <= 0 || input.currentLoss >= baselineLoss * 2)
  if (!latencyRaised && !lossRaised)
    return null
  const kind: TopologyDiagnosisKind = latencyRaised && lossRaised ? 'both' : latencyRaised ? 'latency' : 'loss'
  const message = kind === 'both'
    ? '延迟和丢包同时高于基线，链路质量正在恶化。'
    : kind === 'latency'
      ? '延迟高于基线，可能存在排队或路径时延上升。'
      : '丢包高于基线，但延迟暂未明显变化。'
  return { kind, message, baselineLatency, baselineLoss }
}

export function findTopologyDirectionPairs(candidates: readonly TopologyPairCandidate[]): Record<string, string> {
  const directed = new Map<string, TopologyPairCandidate[]>()
  for (const candidate of candidates) {
    if (!candidate.live || !candidate.sourceUuid || !candidate.targetUuid || candidate.sourceUuid === candidate.targetUuid)
      continue
    const key = `${candidate.sourceUuid}\0${candidate.targetUuid}`
    const list = directed.get(key) ?? []
    list.push(candidate)
    directed.set(key, list)
  }
  const pairs: Record<string, string> = {}
  for (const [key, list] of directed) {
    if (list.length !== 1)
      continue
    const [sourceUuid, targetUuid] = key.split('\0')
    const reverse = directed.get(`${targetUuid}\0${sourceUuid}`)
    if (reverse?.length !== 1)
      continue
    pairs[list[0]!.routeKey] = reverse[0]!.routeKey
  }
  return pairs
}

interface HourlyLatencyPoint {
  at: number
  latency: number
  beijingHour: number
}

function hourlyLatencyPoints(points: readonly TopologyInsightPoint[]): HourlyLatencyPoint[] {
  const buckets = new Map<number, number[]>()
  for (const point of points) {
    if (point.latency === null || !Number.isFinite(point.latency))
      continue
    const at = Math.floor(point.at / HOUR_MS) * HOUR_MS
    const values = buckets.get(at) ?? []
    values.push(point.latency)
    buckets.set(at, values)
  }
  return [...buckets.entries()]
    .map(([at, values]) => ({ at, latency: median(values)!, beijingHour: getBeijingHour(at) }))
    .sort((left, right) => left.at - right.at)
}

export function detectTopologyBaselineShift(
  points: readonly TopologyInsightPoint[],
  options: { stale?: boolean } = {},
): TopologyBaselineShift | null {
  if (options.stale)
    return null
  const taskIds = new Set(points.map(point => point.taskId))
  if (taskIds.size !== 1)
    return null
  const hours = hourlyLatencyPoints(points)
  if (hours.length < 48 || (hours.at(-1)?.at ?? 0) - (hours[0]?.at ?? 0) < 72 * HOUR_MS)
    return null

  const matches: TopologyBaselineShift[] = []
  for (let index = 0; index < hours.length; index++) {
    const candidate = hours[index]!
    const confirmation = hours.filter(item => item.at >= candidate.at && item.at < candidate.at + 6 * HOUR_MS)
    if (confirmation.length < 5)
      continue
    if (confirmation.some((item, itemIndex) => itemIndex > 0 && item.at - confirmation[itemIndex - 1]!.at > 2 * HOUR_MS))
      continue

    const comparisons = confirmation.flatMap((item) => {
      const historical = hours
        .slice(0, index)
        .filter(previous => previous.beijingHour === item.beijingHour && previous.at < candidate.at)
        .map(previous => previous.latency)
      const expected = historical.length >= 3 ? median(historical) : null
      return expected === null ? [] : [{ actual: item.latency, expected, at: item.at }]
    })
    if (comparisons.length < 5)
      continue
    const candidateComparison = comparisons.find(item => item.at === candidate.at)
    if (!candidateComparison)
      continue
    const beforeMedian = median(comparisons.map(item => item.expected))!
    const afterMedian = median(comparisons.map(item => item.actual))!
    const deltaMs = afterMedian - beforeMedian
    const threshold = Math.max(20, beforeMedian * 0.3)
    const candidateDelta = candidateComparison.actual - candidateComparison.expected
    const direction = deltaMs >= threshold && candidateDelta >= threshold
      ? 'degraded'
      : deltaMs <= -threshold && candidateDelta <= -threshold
        ? 'improved'
        : null
    if (!direction)
      continue
    matches.push({
      at: candidate.at,
      beforeMedian,
      afterMedian,
      deltaMs,
      deltaPercent: beforeMedian > 0 ? deltaMs / beforeMedian * 100 : 0,
      direction,
    })
  }
  if (!matches.length)
    return null

  const clusters: Array<{ event: TopologyBaselineShift, lastAt: number }> = []
  for (const match of matches) {
    const previous = clusters.at(-1)
    if (previous && previous.event.direction === match.direction && match.at - previous.lastAt <= 12 * HOUR_MS) {
      previous.lastAt = match.at
      continue
    }
    clusters.push({ event: match, lastAt: match.at })
  }
  return clusters.at(-1)?.event ?? null
}
