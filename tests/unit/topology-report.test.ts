import type { TopologySegmentReliabilitySnapshot } from '../../src/utils/topologyIntelligence'
import { describe, expect, test } from 'bun:test'
import { buildTopologyDiagnosticReport, redactDiagnosticReport } from '../../src/utils/topologyReport'

function reliability(): TopologySegmentReliabilitySnapshot {
  return {
    day: { hours: 24, availability: 99.9, avgLatency: 100, p50Latency: 90, p95Latency: 130, sampleCount: 20, hasData: true, stale: false, loading: false, error: null },
    week: { hours: 168, availability: 99.8, avgLatency: 110, p50Latency: 95, p95Latency: 140, sampleCount: 168, hasData: true, stale: false, loading: false, error: null },
    adaptive: { baselineLatency: 90, thresholdLatency: 130, deviationPercent: 44, label: '明显偏离', tone: 'critical' },
    insights: {
      live: true,
      sourceUuid: '00000000-0000-4000-8000-000000000001',
      taskId: 18,
      taskName: 'Secret-Task-203.0.113.5',
      diagnosis: { kind: 'latency', message: '延迟高于基线，可能存在排队或路径时延上升。', baselineLatency: 90, baselineLoss: 0 },
      hourlyProfile: [],
      peakInsight: {
        status: 'degraded',
        peakLatencyMedian: 150,
        normalLatencyMedian: 90,
        latencyDeltaMs: 60,
        latencyDeltaPercent: 66.7,
        peakLossMedian: 1,
        normalLossMedian: 0,
        lossDeltaPoints: 1,
        worstHour: 22,
        validPeakHours: 4,
        validNormalHours: 20,
      },
      baselineShift: { at: Date.parse('2026-08-18T00:00:00Z'), beforeMedian: 90, afterMedian: 150, deltaMs: 60, deltaPercent: 66.7, direction: 'degraded' },
      coverage: { from: Date.parse('2026-08-13T00:00:00Z'), to: Date.parse('2026-08-20T00:00:00Z'), sampleCount: 168, stale: false },
      evidence: {
        currentLatency: 150,
        currentLoss: 1,
        baselineLatencyP50: 90,
        baselineLatencyP95: 130,
        baselineLossMedian: 0,
        baselineSampleCount: 22,
        latestSampleAt: Date.parse('2026-08-20T00:00:00Z'),
        freshness: 'fresh',
        dayCoverage: { from: Date.parse('2026-08-19T00:00:00Z'), to: Date.parse('2026-08-20T00:00:00Z'), sampleCount: 24, stale: false },
        weekCoverage: { from: Date.parse('2026-08-13T00:00:00Z'), to: Date.parse('2026-08-20T00:00:00Z'), sampleCount: 168, stale: false },
      },
    },
  }
}

describe('topology diagnostic report', () => {
  test('includes public evidence while excluding exact task and source identifiers', () => {
    const report = buildTopologyDiagnosticReport({
      version: '1.0.43',
      generatedAt: Date.parse('2026-08-20T01:00:00Z'),
      routeName: '广州电信 → 香港中转 → 洛杉矶',
      segments: [{
        sourceName: '广州电信',
        targetName: '香港中转',
        telemetry: { status: 'warning', latency: 150, loss: 1, volatility: 1.2, hasLiveData: true, stale: false },
        reliability: reliability(),
      }],
      directions: [{ label: '正向', sourceName: '香港中转', targetName: '洛杉矶', telemetry: { status: 'healthy', latency: 80, loss: 0, volatility: 0.2, hasLiveData: true, stale: false } }],
    })
    expect(report).toContain('Transit v1.0.43 线路诊断')
    expect(report).toContain('晚高峰延迟高 60 ms')
    expect(report).toContain('24h 基线：P50 90 ms / P95 130 ms')
    expect(report).toContain('双向探测')
    expect(report).not.toContain('00000000-0000-4000-8000-000000000001')
    expect(report).not.toContain('Secret-Task')
    expect(report).not.toContain('任务 ID')
  })

  test('redacts UUID, IPv4, IPv6 and explicit task identifiers after composition', () => {
    const value = redactDiagnosticReport('00000000-0000-4000-8000-000000000001 203.0.113.5 2001:db8::8 2001:db8:1:2:3:4:5:6 task_id=18 任务 ID：19')
    expect(value).not.toMatch(/00000000|203\.0\.113\.5|2001:db8|task_id=18|任务 ID：19/)
    expect(value.match(/\[已隐藏\]/g)?.length).toBeGreaterThanOrEqual(6)
  })
})
