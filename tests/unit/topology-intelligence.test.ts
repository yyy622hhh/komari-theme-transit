import type { TopologySegmentTelemetry } from '../../src/utils/topologyHealth'
import type {
  TopologyReliabilityWindow,
  TopologyRouteRankingInput,
  TopologySegmentReliabilitySnapshot,
} from '../../src/utils/topologyIntelligence'
import { describe, expect, test } from 'bun:test'
import { aggregateTopologyRouteReliability, rankTopologyRoutes } from '../../src/utils/topologyIntelligence'

function window(hours: 24 | 168, overrides: Partial<TopologyReliabilityWindow> = {}): TopologyReliabilityWindow {
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
    ...overrides,
  }
}

function snapshot(latency: number): TopologySegmentReliabilitySnapshot {
  const day = window(24, {
    availability: 100,
    avgLatency: latency,
    p50Latency: latency - 5,
    p95Latency: latency + 20,
    sampleCount: 100,
    hasData: true,
  })
  return {
    day,
    week: { ...day, hours: 168 },
    adaptive: {
      baselineLatency: latency - 5,
      thresholdLatency: latency + 20,
      deviationPercent: 0,
      label: '基线稳定',
      tone: 'healthy',
    },
  }
}

function telemetry(overrides: Partial<TopologySegmentTelemetry> = {}): TopologySegmentTelemetry {
  return {
    status: 'healthy',
    latency: 50,
    loss: 0,
    volatility: 0,
    hasLiveData: true,
    stale: false,
    ...overrides,
  }
}

function rankingInput(overrides: Partial<TopologyRouteRankingInput> & Pick<TopologyRouteRankingInput, 'key'>): TopologyRouteRankingInput {
  return {
    directionKey: 'US',
    healthScore: 100,
    status: 'healthy',
    reliability: aggregateTopologyRouteReliability([telemetry()], []),
    ...overrides,
  }
}

describe('topology route intelligence', () => {
  test('never recommends an offline route over an operational route', () => {
    const rankings = rankTopologyRoutes([
      rankingInput({
        key: 'offline',
        healthScore: 0,
        status: 'offline',
        reliability: aggregateTopologyRouteReliability([telemetry()], [snapshot(50)]),
      }),
      rankingInput({ key: 'operational', healthScore: 60, status: 'warning' }),
    ])

    expect(rankings.operational).toMatchObject({ rank: 1, recommended: true })
    expect(rankings.offline).toMatchObject({ rank: 2, recommended: false })
  })

  test('does not invent a recommendation when every route is pending', () => {
    const rankings = rankTopologyRoutes([
      rankingInput({ key: 'pending-a', healthScore: 82, status: 'pending' }),
      rankingInput({ key: 'pending-b', healthScore: 82, status: 'pending' }),
    ])

    expect(Object.values(rankings).every(item => !item.recommended && !item.reason)).toBe(true)
  })

  test('does not add independent segment percentiles into a route percentile', () => {
    const reliability = aggregateTopologyRouteReliability(
      [telemetry({ latency: 50 }), telemetry({ latency: 70 })],
      [snapshot(50), snapshot(70)],
    )

    expect(reliability.day).toMatchObject({
      hasData: true,
      avgLatency: 120,
      p50Latency: null,
      p95Latency: null,
    })
    expect(reliability.adaptive.baselineLatency).toBe(120)
  })

  test('does not compare a pending fallback value with historical telemetry', () => {
    const reliability = aggregateTopologyRouteReliability(
      [telemetry({ status: 'pending', latency: 50, hasLiveData: false })],
      [snapshot(50)],
    )

    expect(reliability.adaptive).toMatchObject({ label: '待数据', tone: 'pending', deviationPercent: null })
  })

  test('keeps real percentiles for a single-segment route', () => {
    const reliability = aggregateTopologyRouteReliability([telemetry()], [snapshot(50)])

    expect(reliability.day).toMatchObject({ p50Latency: 45, p95Latency: 70 })
  })
})
