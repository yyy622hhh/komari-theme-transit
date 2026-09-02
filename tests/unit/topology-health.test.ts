import type { TopologySegmentTelemetry } from '../../src/utils/topologyHealth'
import { describe, expect, test } from 'bun:test'
import { calculateTopologyRouteScore, resolveTopologySampleWindow, resolveTopologySegmentHealth } from '../../src/utils/topologyHealth'

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
  test('keeps raw loss visible but does not classify a thin new window as failed', () => {
    expect(resolveTopologySegmentHealth({
      live: true,
      sourceExists: true,
      sourceOnline: true,
      loading: false,
      error: null,
      stale: false,
      hasData: true,
      avgLatency: 20,
      avgLoss: 60,
      avgVolatility: 0,
      fallbackLatency: null,
      fallbackLoss: null,
      sampleCount: 21,
    })).toBe('pending')
  })

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

  test('keeps an automatic segment pending even when it still carries an old fallback baseline', () => {
    expect(resolveTopologySegmentHealth({
      live: false,
      probeMode: 'auto',
      sourceExists: false,
      loading: false,
      error: null,
      stale: false,
      hasData: false,
      avgLatency: null,
      avgLoss: 0,
      avgVolatility: 0,
      fallbackLatency: 40,
      fallbackLoss: 0,
    })).toBe('pending')
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

describe('topology sample window confidence', () => {
  test('shows the observed range and denominator while a task is still collecting', () => {
    expect(resolveTopologySampleWindow({
      sampleCount: 21,
      from: Date.parse('2026-09-02T08:00:00Z'),
      to: Date.parse('2026-09-02T08:10:00Z'),
      intervalSeconds: 30,
    })).toMatchObject({
      coverageMinutes: 10,
      completeWindow: false,
      sufficient: false,
      label: '近 10 分钟 · 21 次',
    })
  })

  test('starts classification at 30 samples without claiming a full hour', () => {
    expect(resolveTopologySampleWindow({
      sampleCount: 30,
      intervalSeconds: 30,
    })).toMatchObject({
      coverageMinutes: 15,
      completeWindow: false,
      sufficient: true,
      label: '近 15 分钟 · 30 次',
    })
  })

  test('uses the full-window label only after enough temporal coverage', () => {
    expect(resolveTopologySampleWindow({
      sampleCount: 120,
      intervalSeconds: 30,
    })).toMatchObject({
      coverageMinutes: 60,
      completeWindow: true,
      sufficient: true,
      label: '近 1 小时 · 120 次',
    })
  })

  test('prefers observed timestamps over an interval estimate', () => {
    expect(resolveTopologySampleWindow({
      sampleCount: 120,
      from: Date.parse('2026-09-02T08:00:00Z'),
      to: Date.parse('2026-09-02T08:10:00Z'),
      intervalSeconds: 30,
    })).toMatchObject({
      coverageMinutes: 10,
      completeWindow: false,
      sufficient: true,
      label: '近 10 分钟 · 120 次',
    })
  })
})

describe('latency penalty monotonicity', () => {
  function scoreForLatency(latency: number): number {
    return calculateTopologyRouteScore({
      segments: [segment({ latency, loss: 0, volatility: 0 })],
      segmentLabels: ['入口'],
      hasOfflineNode: false,
      hasMissingNode: false,
    }).score
  }

  test('never scores a worse latency higher across the whole range', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let latency = 0; latency <= 700; latency += 0.5) {
      const score = scoreForLatency(latency)
      expect(score).toBeLessThanOrEqual(previous)
      previous = score
    }
  })

  test('stays continuous across the 250ms segment boundary', () => {
    // 修复前：250ms 扣 40.4 分，250.5ms 只扣 40.05 分，延迟更差反而分更高。
    expect(scoreForLatency(250)).toBeGreaterThanOrEqual(scoreForLatency(250.5))
    // 分数取整，相邻 1ms 之间最多差 1 分；修复前这里会是负数（分数不降反升）。
    expect(scoreForLatency(250) - scoreForLatency(251)).toBeLessThanOrEqual(1)
    expect(scoreForLatency(250) - scoreForLatency(251)).toBeGreaterThanOrEqual(0)
  })
})
