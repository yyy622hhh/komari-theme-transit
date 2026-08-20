import type { MetricLossPoint } from '../../src/utils/pingStats'
import type { PingRecord } from '../../src/utils/rpc'
import type { TopologyInsightPoint } from '../../src/utils/topologyInsights'
import { describe, expect, test } from 'bun:test'
import {
  analyzeTopologyPeakInsight,
  bucketTopologyInsightsByBeijingHour,
  buildTopologyInsightPoints,
  calculateTopologyInsightBaseline,
  describeTopologyPeakInsight,
  detectTopologyBaselineShift,
  diagnoseTopologySegment,
  findTopologyDirectionPairs,
  getBeijingHour,
  getTopologyInsightCoverage,
} from '../../src/utils/topologyInsights'

const HOUR_MS = 60 * 60 * 1000
const START = Date.parse('2026-08-10T00:00:00.000Z')

function point(hour: number, latency: number | null, loss: number | null, taskId = 7): TopologyInsightPoint {
  return { at: START + hour * HOUR_MS, taskId, latency, loss }
}

function series(hours: number, latencyAt: (hour: number) => number, taskIdAt: (hour: number) => number = () => 7): TopologyInsightPoint[] {
  return Array.from({ length: hours }, (_, hour) => point(hour, latencyAt(hour), 0, taskIdAt(hour)))
}

function diagnosisHistory(): TopologyInsightPoint[] {
  return Array.from({ length: 14 }, (_, index) => point(index, 100, 0))
}

describe('topology latency and loss diagnosis', () => {
  const base = {
    hasLiveData: true,
    stale: false,
    history: diagnosisHistory(),
  }

  test('returns no conclusion when latency and loss stay at baseline', () => {
    expect(diagnoseTopologySegment({ ...base, currentLatency: 100, currentLoss: 0 })).toBeNull()
  })

  test('distinguishes latency-only, loss-only and combined degradation', () => {
    expect(diagnoseTopologySegment({ ...base, currentLatency: 121, currentLoss: 0 })?.kind).toBe('latency')
    expect(diagnoseTopologySegment({ ...base, currentLatency: 100, currentLoss: 3 })?.kind).toBe('loss')
    expect(diagnoseTopologySegment({ ...base, currentLatency: 121, currentLoss: 3 })?.kind).toBe('both')
  })

  test('uses strict latency threshold and inclusive loss threshold', () => {
    expect(diagnoseTopologySegment({ ...base, currentLatency: 120, currentLoss: 0 })).toBeNull()
    expect(diagnoseTopologySegment({ ...base, currentLatency: 100, currentLoss: 2.99 })).toBeNull()
  })

  test('suppresses conclusions for stale, missing or thin data', () => {
    expect(diagnoseTopologySegment({ ...base, stale: true, currentLatency: 200, currentLoss: 20 })).toBeNull()
    expect(diagnoseTopologySegment({ ...base, currentLatency: null, currentLoss: 20 })).toBeNull()
    expect(diagnoseTopologySegment({ ...base, history: diagnosisHistory().slice(0, 12), currentLatency: 200, currentLoss: 20 })).toBeNull()
  })
})

describe('Beijing hourly topology buckets', () => {
  test('maps UTC across the local-day boundary without daylight-saving drift', () => {
    expect(getBeijingHour(Date.parse('2026-01-10T16:15:00.000Z'))).toBe(0)
    expect(getBeijingHour(Date.parse('2026-07-10T16:15:00.000Z'))).toBe(0)
    expect(getBeijingHour(Date.parse('2026-08-10T15:59:00.000Z'))).toBe(23)
  })

  test('returns medians only when each metric has three valid samples', () => {
    const inputs = [
      { at: Date.parse('2026-08-10T12:05:00Z'), taskId: 7, latency: 100, loss: 0 },
      { at: Date.parse('2026-08-11T12:05:00Z'), taskId: 7, latency: 140, loss: 4 },
      { at: Date.parse('2026-08-12T12:05:00Z'), taskId: 7, latency: 120, loss: 2 },
      { at: Date.parse('2026-08-13T12:05:00Z'), taskId: 7, latency: null, loss: 8 },
      { at: Date.parse('2026-08-10T11:05:00Z'), taskId: 7, latency: 99, loss: 0 },
    ]
    const buckets = bucketTopologyInsightsByBeijingHour(inputs)
    expect(buckets).toHaveLength(24)
    expect(buckets[20]).toMatchObject({ latencyMedian: 120, lossMedian: 3, sampleCount: 4 })
    expect(buckets[19]).toMatchObject({ latencyMedian: null, lossMedian: null, sampleCount: 1 })
    expect(buckets[0]).toMatchObject({ latencyMedian: null, lossMedian: null, sampleCount: 0 })
  })
})

function hourlyBuckets(options: {
  normalLatency?: number | null
  peakLatency?: number | null
  normalLoss?: number | null
  peakLoss?: number | null
} = {}) {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    latencyMedian: hour >= 20 ? options.peakLatency ?? 100 : options.normalLatency ?? 100,
    lossMedian: hour >= 20 ? options.peakLoss ?? 0 : options.normalLoss ?? 0,
    sampleCount: 7,
  }))
}

describe('topology evening peak insight', () => {
  test('detects latency, loss and combined degradation at inclusive thresholds', () => {
    const latency = analyzeTopologyPeakInsight(hourlyBuckets({ normalLatency: 100, peakLatency: 130 }), { taskId: 7 })
    expect(latency).toMatchObject({ status: 'degraded', latencyDeltaMs: 30, worstHour: 20 })

    const absolute = analyzeTopologyPeakInsight(hourlyBuckets({ normalLatency: 50, peakLatency: 70 }), { taskId: 7 })
    expect(absolute?.status).toBe('degraded')

    const loss = analyzeTopologyPeakInsight(hourlyBuckets({ normalLoss: 0, peakLoss: 3 }), { taskId: 7 })
    expect(loss).toMatchObject({ status: 'degraded', lossDeltaPoints: 3, worstHour: 20 })

    const both = analyzeTopologyPeakInsight(hourlyBuckets({ normalLatency: 100, peakLatency: 145, normalLoss: 1, peakLoss: 5 }), { taskId: 7 })
    expect(describeTopologyPeakInsight(both!)).toContain('晚高峰延迟高 45 ms，丢包高 4.0 个百分点')
  })

  test('keeps sub-threshold differences stable and picks the worst peak hour', () => {
    const buckets = hourlyBuckets({ normalLatency: 100, peakLatency: 130, normalLoss: 1, peakLoss: 3 })
    buckets[22]!.latencyMedian = 170
    const insight = analyzeTopologyPeakInsight(buckets, { taskId: 7 })
    expect(insight).toMatchObject({ status: 'degraded', worstHour: 22 })

    expect(analyzeTopologyPeakInsight(hourlyBuckets({ normalLatency: 100, peakLatency: 129, normalLoss: 1, peakLoss: 3 }), { taskId: 7 })?.status).toBe('stable')
    expect(analyzeTopologyPeakInsight(hourlyBuckets({ normalLatency: 100, peakLatency: 120, normalLoss: 2, peakLoss: 4 }), { taskId: 7 })?.status).toBe('stable')
  })

  test('suppresses stale, ambiguous and thin hourly coverage', () => {
    expect(analyzeTopologyPeakInsight(hourlyBuckets({ peakLatency: 160 }), { stale: true, taskId: 7 })).toBeNull()
    expect(analyzeTopologyPeakInsight(hourlyBuckets({ peakLatency: 160 }), { taskId: null })).toBeNull()

    const thinPeak = hourlyBuckets({ peakLatency: 160 })
    thinPeak[20]!.latencyMedian = null
    thinPeak[20]!.lossMedian = null
    thinPeak[21]!.latencyMedian = null
    thinPeak[21]!.lossMedian = null
    expect(analyzeTopologyPeakInsight(thinPeak, { taskId: 7 })).toBeNull()

    const thinNormal = hourlyBuckets({ peakLatency: 160 })
    for (let hour = 0; hour < 9; hour++) {
      thinNormal[hour]!.latencyMedian = null
      thinNormal[hour]!.lossMedian = null
    }
    expect(analyzeTopologyPeakInsight(thinNormal, { taskId: 7 })).toBeNull()
  })
})

describe('topology insight evidence baseline', () => {
  test('excludes the newest hour and matches diagnosis baseline values', () => {
    const history = [...diagnosisHistory(), point(14, 500, 20)]
    const baseline = calculateTopologyInsightBaseline(history)
    expect(baseline).toMatchObject({ latencyP50: 100, latencyP95: 100, lossMedian: 0, sampleCount: 14 })
    expect(diagnoseTopologySegment({
      hasLiveData: true,
      stale: false,
      currentLatency: 150,
      currentLoss: 4,
      history,
    })).toMatchObject({ baselineLatency: baseline.latencyP50, baselineLoss: baseline.lossMedian })
  })
})

describe('configured reverse topology pairing', () => {
  test('pairs one unique live route in each direction by UUID', () => {
    expect(findTopologyDirectionPairs([
      { routeKey: 'renamed-a', sourceUuid: 'a', targetUuid: 'b', live: true },
      { routeKey: 'renamed-b', sourceUuid: 'b', targetUuid: 'a', live: true },
    ])).toEqual({ 'renamed-a': 'renamed-b', 'renamed-b': 'renamed-a' })
  })

  test('does not pair single, self, static or duplicate candidates', () => {
    expect(findTopologyDirectionPairs([
      { routeKey: 'one-way', sourceUuid: 'a', targetUuid: 'b', live: true },
      { routeKey: 'self', sourceUuid: 'a', targetUuid: 'a', live: true },
      { routeKey: 'static-reverse', sourceUuid: 'b', targetUuid: 'a', live: false },
    ])).toEqual({})
    expect(findTopologyDirectionPairs([
      { routeKey: 'a-1', sourceUuid: 'a', targetUuid: 'b', live: true },
      { routeKey: 'a-2', sourceUuid: 'a', targetUuid: 'b', live: true },
      { routeKey: 'b', sourceUuid: 'b', targetUuid: 'a', live: true },
    ])).toEqual({})
  })
})

describe('topology baseline shift detection', () => {
  test('detects one sustained degradation and keeps its onset time', () => {
    const points = series(144, hour => hour < 96 ? 100 : 150)
    const shift = detectTopologyBaselineShift(points)
    expect(shift).toMatchObject({
      at: START + 96 * HOUR_MS,
      beforeMedian: 100,
      afterMedian: 150,
      deltaMs: 50,
      direction: 'degraded',
    })
  })

  test('does not mistake a repeated evening peak for a step change', () => {
    const points = series(168, (hour) => {
      const beijingHour = getBeijingHour(START + hour * HOUR_MS)
      return beijingHour >= 20 && beijingHour <= 23 ? 160 : 100
    })
    expect(detectTopologyBaselineShift(points)).toBeNull()
  })

  test('ignores slow drift, one spike and a confirmation window with a large gap', () => {
    expect(detectTopologyBaselineShift(series(168, hour => 100 + hour * 0.1))).toBeNull()
    expect(detectTopologyBaselineShift(series(168, hour => hour === 120 ? 220 : 100))).toBeNull()
    const gap = series(150, hour => hour === 100 || (hour >= 103 && hour < 105) ? 160 : 100)
      .filter((_, hour) => hour !== 101 && hour !== 102)
    expect(detectTopologyBaselineShift(gap)).toBeNull()
  })

  test('never joins different task IDs and suppresses stale or short coverage', () => {
    const changedTask = series(144, hour => hour < 96 ? 100 : 150, hour => hour < 96 ? 1 : 2)
    expect(detectTopologyBaselineShift(changedTask)).toBeNull()
    expect(detectTopologyBaselineShift(series(144, hour => hour < 96 ? 100 : 150), { stale: true })).toBeNull()
    expect(detectTopologyBaselineShift(series(70, hour => hour < 50 ? 100 : 150))).toBeNull()
  })

  test('reports a sustained improvement only in the detailed result', () => {
    const shift = detectTopologyBaselineShift(series(144, hour => hour < 96 ? 150 : 95))
    expect(shift?.direction).toBe('improved')
    expect(shift?.deltaMs).toBe(-55)
  })
})

describe('detailed insight point normalization', () => {
  test('produces the same shape for Metric Store loss and legacy records', () => {
    const time = '2026-08-20T00:00:00.000Z'
    const records: PingRecord[] = [{ client: 'node-a', task_id: 7, time, value: 80 }]
    const metricLoss: MetricLossPoint[] = [{ taskId: 7, time, value: 0, count: 1 }]
    expect(buildTopologyInsightPoints(records, metricLoss)).toEqual([
      { at: Date.parse(time), taskId: 7, latency: 80, loss: 0 },
    ])
    expect(buildTopologyInsightPoints(records)).toEqual([
      { at: Date.parse(time), taskId: 7, latency: 80, loss: 0 },
    ])
  })

  test('keeps at most 240 detailed points for each exact task', () => {
    const records: PingRecord[] = Array.from({ length: 260 }, (_, index) => ({
      client: 'node-a',
      task_id: 7,
      time: new Date(START + index * HOUR_MS).toISOString(),
      value: 80,
    }))
    const normalized = buildTopologyInsightPoints(records, [], new Set([7]))
    expect(normalized).toHaveLength(240)
    expect(normalized[0]?.at).toBe(START + 20 * HOUR_MS)
    expect(getTopologyInsightCoverage(normalized, true)).toEqual({
      from: START + 20 * HOUR_MS,
      to: START + 259 * HOUR_MS,
      sampleCount: 240,
      stale: true,
    })
  })
})
