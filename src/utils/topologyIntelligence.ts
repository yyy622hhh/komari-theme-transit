import type { TopologyRouteHealth, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyBaselineShift, TopologyDiagnosis, TopologyHourlyBucket, TopologyInsightCoverage, TopologyInsightEvidence, TopologyPeakInsight } from '@/utils/topologyInsights'
import type { TopologyProbeMode } from '@/utils/topologyModel'

export interface TopologyReliabilityWindow {
  hours: 24 | 168
  availability: number | null
  avgLatency: number | null
  p50Latency: number | null
  p95Latency: number | null
  sampleCount: number
  hasData: boolean
  stale: boolean
  loading: boolean
  error: string | null
  windowLabel?: string
  completeWindow?: boolean
}

export interface TopologyAdaptiveBaseline {
  baselineLatency: number | null
  thresholdLatency: number | null
  deviationPercent: number | null
  label: '基线稳定' | '轻微偏离' | '明显偏离' | '待数据'
  tone: 'healthy' | 'warning' | 'critical' | 'pending'
}

export interface TopologySegmentReliabilitySnapshot {
  day: TopologyReliabilityWindow
  week: TopologyReliabilityWindow
  adaptive: TopologyAdaptiveBaseline
  insights?: {
    live: boolean
    probeMode?: TopologyProbeMode
    sourceUuid: string
    taskId: number | null
    taskName: string
    probeType?: string
    diagnosis: TopologyDiagnosis | null
    hourlyProfile: TopologyHourlyBucket[]
    peakInsight: TopologyPeakInsight | null
    baselineShift: TopologyBaselineShift | null
    coverage: TopologyInsightCoverage
    evidence: TopologyInsightEvidence
  }
}

export interface TopologyRouteReliability {
  day: TopologyReliabilityWindow
  week: TopologyReliabilityWindow
  adaptive: TopologyAdaptiveBaseline
  completeSegments: number
  totalSegments: number
}

export interface TopologyRouteRanking {
  rank: number
  total: number
  recommended: boolean
  compositeScore: number
  reason: string
  hasHistoricalData: boolean
}

export interface TopologyRouteRankingInput {
  key: string
  directionKey: string
  healthScore: number
  status: TopologyRouteHealth
  reliability: TopologyRouteReliability
}

function emptyWindow(hours: 24 | 168): TopologyReliabilityWindow {
  return {
    hours,
    availability: null,
    avgLatency: null,
    p50Latency: null,
    p95Latency: null,
    sampleCount: 0,
    hasData: false,
    stale: false,
    loading: false,
    error: null,
  }
}

function sumNullable(values: Array<number | null>): number | null {
  return values.every(value => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null
}

export function calculateAdaptiveBaseline(
  currentLatency: number | null,
  historical: Pick<TopologyReliabilityWindow, 'hasData' | 'p50Latency' | 'p95Latency'>,
): TopologyAdaptiveBaseline {
  const baseline = historical.p50Latency
  if (!historical.hasData || currentLatency === null || baseline === null || baseline <= 0) {
    return {
      baselineLatency: baseline,
      thresholdLatency: null,
      deviationPercent: null,
      label: '待数据',
      tone: 'pending',
    }
  }

  const historicalP95 = historical.p95Latency ?? baseline
  const threshold = Math.max(baseline * 1.2, historicalP95)
  const criticalThreshold = Math.max(baseline * 1.5, threshold * 1.2)
  const deviationPercent = (currentLatency - baseline) / baseline * 100

  if (currentLatency > criticalThreshold) {
    return {
      baselineLatency: baseline,
      thresholdLatency: threshold,
      deviationPercent,
      label: '明显偏离',
      tone: 'critical',
    }
  }
  if (currentLatency > threshold) {
    return {
      baselineLatency: baseline,
      thresholdLatency: threshold,
      deviationPercent,
      label: '轻微偏离',
      tone: 'warning',
    }
  }
  return {
    baselineLatency: baseline,
    thresholdLatency: threshold,
    deviationPercent,
    label: '基线稳定',
    tone: 'healthy',
  }
}

function aggregateWindow(
  snapshots: TopologySegmentReliabilitySnapshot[],
  key: 'day' | 'week',
  expectedSegments: number,
): TopologyReliabilityWindow {
  const hours = key === 'day' ? 24 : 168
  if (!snapshots.length)
    return emptyWindow(hours)

  const windows = snapshots.map(snapshot => snapshot[key])
  const complete = snapshots.length === expectedSegments && windows.every(window => window.hasData)
  const hasEndToEndPercentiles = complete && expectedSegments === 1
  return {
    hours,
    availability: complete ? Math.min(...windows.map(window => window.availability ?? 0)) : null,
    avgLatency: complete ? sumNullable(windows.map(window => window.avgLatency)) : null,
    // Segment percentiles cannot be added into an end-to-end percentile without
    // time-correlated samples. Keep them only for a single-segment route.
    p50Latency: hasEndToEndPercentiles ? windows[0]?.p50Latency ?? null : null,
    p95Latency: hasEndToEndPercentiles ? windows[0]?.p95Latency ?? null : null,
    sampleCount: complete ? Math.min(...windows.map(window => window.sampleCount)) : 0,
    hasData: complete,
    stale: windows.some(window => window.stale),
    loading: windows.some(window => window.loading),
    error: windows.find(window => window.error)?.error ?? null,
  }
}

export function aggregateTopologyRouteReliability(
  currentSegments: Array<TopologySegmentTelemetry | undefined>,
  historicalSegments: Array<TopologySegmentReliabilitySnapshot | undefined>,
): TopologyRouteReliability {
  const snapshots = historicalSegments.filter((item): item is TopologySegmentReliabilitySnapshot => Boolean(item))
  const totalSegments = Math.max(currentSegments.length, historicalSegments.length)
  const day = aggregateWindow(snapshots, 'day', totalSegments)
  const week = aggregateWindow(snapshots, 'week', totalSegments)
  const currentLatency = currentSegments.length && currentSegments.every(segment => segment
    && (segment.status === 'healthy' || segment.status === 'warning')
    && !segment.stale
    && segment.latency !== null)
    ? currentSegments.reduce((sum, segment) => sum + (segment?.latency ?? 0), 0)
    : null
  const adaptiveHistory = day.p50Latency === null && day.avgLatency !== null
    ? { ...day, p50Latency: day.avgLatency }
    : day
  return {
    day,
    week,
    adaptive: calculateAdaptiveBaseline(currentLatency, adaptiveHistory),
    completeSegments: snapshots.filter(snapshot => snapshot.day.hasData).length,
    totalSegments,
  }
}

function rankingScore(input: TopologyRouteRankingInput, fastestLatency: number | null): number {
  const day = input.reliability.day
  const availabilityScore = day.availability ?? 50
  const latencyScore = day.avgLatency !== null && fastestLatency !== null && day.avgLatency > 0
    ? Math.min(100, fastestLatency / day.avgLatency * 100)
    : 50
  const historyWeight = day.hasData ? 1 : 0.55
  return Math.max(0, Math.min(100, input.healthScore * (0.35 + (1 - historyWeight) * 0.45)
    + availabilityScore * 0.45 * historyWeight
    + latencyScore * 0.2 * historyWeight))
}

function recommendationEligible(input: TopologyRouteRankingInput): boolean {
  return (input.status === 'healthy' || input.status === 'warning') && input.healthScore >= 55
}

function recommendationReason(best: TopologyRouteRankingInput, runnerUp?: TopologyRouteRankingInput): string {
  if (!best.reliability.day.hasData)
    return '当前健康分更高，历史数据仍在积累'
  if (!runnerUp?.reliability.day.hasData)
    return '24h 历史数据更完整'

  const availabilityLead = (best.reliability.day.availability ?? 0) - (runnerUp.reliability.day.availability ?? 0)
  const latencyLead = (runnerUp.reliability.day.avgLatency ?? 0) - (best.reliability.day.avgLatency ?? 0)
  const healthLead = best.healthScore - runnerUp.healthScore

  if (availabilityLead >= 0.2)
    return `24h 可用率高 ${availabilityLead.toFixed(1)}%`
  if (latencyLead >= 3)
    return `平均延迟低 ${Math.round(latencyLead)} ms`
  if (healthLead >= 2)
    return `当前健康分高 ${Math.round(healthLead)} 分`
  return '综合可用率、延迟与当前状态更优'
}

export function rankTopologyRoutes(inputs: TopologyRouteRankingInput[]): Record<string, TopologyRouteRanking> {
  const result: Record<string, TopologyRouteRanking> = {}
  const groups = new Map<string, TopologyRouteRankingInput[]>()
  for (const input of inputs) {
    const group = groups.get(input.directionKey) ?? []
    group.push(input)
    groups.set(input.directionKey, group)
  }

  for (const group of groups.values()) {
    const eligibleGroup = group.filter(recommendationEligible)
    const validLatencies = eligibleGroup
      .map(input => input.reliability.day.avgLatency)
      .filter((value): value is number => value !== null && value > 0)
    const fastestLatency = validLatencies.length ? Math.min(...validLatencies) : null
    const ranked = eligibleGroup
      .map(input => ({ input, score: rankingScore(input, fastestLatency) }))
      .sort((left, right) => right.score - left.score
        || left.input.key.localeCompare(right.input.key))

    ranked.forEach((item, index) => {
      result[item.input.key] = {
        rank: index + 1,
        total: ranked.length,
        recommended: ranked.length > 1 && index === 0,
        compositeScore: Math.round(item.score),
        reason: index === 0 ? recommendationReason(item.input, ranked[1]?.input) : '',
        hasHistoricalData: item.input.reliability.day.hasData,
      }
    })
  }
  return result
}
