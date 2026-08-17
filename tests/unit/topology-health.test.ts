import type { TopologySegmentTelemetry } from '../../src/utils/topologyHealth'
import { describe, expect, test } from 'bun:test'
import { calculateTopologyRouteScore, resolveTopologySegmentHealth } from '../../src/utils/topologyHealth'

function segment(overrides: Partial<TopologySegmentTelemetry> = {}): TopologySegmentTelemetry {
  return {
    status: 'healthy',
    latency: 40,
    loss: 0,
    volatility: 0.2,
    hasLiveData: true,
    stale: false,
    ...overrides,
  }
}

describe('topology health scoring', () => {
  test('keeps a partially sampled route in the pending state', () => {
    const score = calculateTopologyRouteScore({
      segments: [segment(), undefined],
      segmentLabels: ['入口至线路机', '线路机至落地机'],
      hasOfflineNode: false,
      hasMissingNode: false,
    })

    expect(score.score).toBe(91)
    expect(score.label).toBe('待数据')
    expect(score.tone).toBe('pending')
  })

  test('marks extreme latency as critical instead of healthy', () => {
    const score = calculateTopologyRouteScore({
      segments: [segment({ latency: 1_000 })],
      segmentLabels: ['入口至线路机'],
      hasOfflineNode: false,
      hasMissingNode: false,
    })

    expect(score).toMatchObject({ score: 45, label: '异常', tone: 'critical' })
    expect(resolveTopologySegmentHealth({
      live: true,
      sourceExists: true,
      sourceOnline: true,
      loading: false,
      error: null,
      stale: false,
      hasData: true,
      avgLatency: 1_000,
      avgLoss: 0,
      avgVolatility: 0,
      fallbackLatency: null,
      fallbackLoss: null,
    })).toBe('error')
  })

  test('marks an extreme static baseline as an error', () => {
    expect(resolveTopologySegmentHealth({
      live: false,
      sourceExists: false,
      loading: false,
      error: null,
      stale: false,
      hasData: false,
      avgLatency: null,
      avgLoss: 0,
      avgVolatility: 0,
      fallbackLatency: 5_000,
      fallbackLoss: 0,
    })).toBe('error')
  })

  test('scores severe loss as an outage deduction', () => {
    const score = calculateTopologyRouteScore({
      segments: [segment({ status: 'error', loss: 100 })],
      segmentLabels: ['入口至线路机'],
      hasOfflineNode: false,
      hasMissingNode: false,
    })

    expect(score).toMatchObject({ score: 0, label: '异常', tone: 'critical' })
    expect(score.deductions[0]).toMatchObject({ key: '0:loss-critical', points: 100 })
  })
})
