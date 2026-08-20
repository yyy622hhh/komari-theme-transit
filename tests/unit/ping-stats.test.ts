import type { MetricLossPoint } from '../../src/utils/pingStats'
import type { MetricQueryResponse, MetricSeries, PingMetricStatsResponse, PingMetricTaskStats, PingRecord } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { buildPingMetricState, collectNodePingTaskIds, pickPreferredExactPingTaskId } from '../../src/composables/useNodePingStats'
import { buildNodePingStats, createEmptyNodePingStats, matchesPingTaskName, normalizePingTaskFilter } from '../../src/utils/pingStats'

const nodeUuid = 'node-a'

function pingStat(overrides: Partial<PingMetricTaskStats> = {}): PingMetricTaskStats {
  return {
    entity_id: nodeUuid,
    task_id: '1',
    total: 48,
    valid: 48,
    loss: 0,
    loss_approximate: false,
    tags: {},
    ...overrides,
  }
}

function lossSeries(taskId: string, points: Array<{ time: string, value: number }> = [{ time: '2026-08-15T00:00:00.000Z', value: 0 }]): MetricSeries {
  return {
    metric_key: 'ping.loss',
    entity_id: nodeUuid,
    downsampled: false,
    tags: { task_id: taskId },
    points,
  }
}

function latencySeries(taskId: string, points: Array<{ time: string, value: number | null }> = [{ time: '2026-08-15T00:00:00.000Z', value: 50 }]): MetricSeries {
  return {
    metric_key: 'ping.latency_ms',
    entity_id: nodeUuid,
    downsampled: false,
    tags: { task_id: taskId },
    points,
  }
}

function statsResponse(stats: PingMetricTaskStats[]): PingMetricStatsResponse {
  return { start: '2026-08-15T00:00:00.000Z', end: '2026-08-15T01:00:00.000Z', interval_seconds: 60, stats, count: stats.length }
}

function metricsResponse(series: MetricSeries[]): MetricQueryResponse {
  return { start: '2026-08-15T00:00:00.000Z', end: '2026-08-15T01:00:00.000Z', series, count: series.length }
}

/** Mirrors the private normalizeTaskId() hash fallback in useNodePingStats.ts. */
function hashTaskId(taskId: string): number {
  let hash = 0
  for (let index = 0; index < taskId.length; index++)
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0
  return Math.abs(hash)
}

describe('ping statistics helpers', () => {
  test('builds legacy latency, loss, percentile and availability values', () => {
    const records: PingRecord[] = [
      { client: 'node-a', task_id: 1, time: '2026-08-15T00:00:00.000Z', value: 100 },
      { client: 'node-a', task_id: 1, time: '2026-08-15T00:01:00.000Z', value: -1 },
      { client: 'node-a', task_id: 1, time: '2026-08-15T00:02:00.000Z', value: 200 },
    ]

    const stats = buildNodePingStats(records)
    expect(stats.hasData).toBe(true)
    expect(stats.sampleCount).toBe(3)
    expect(stats.avgLatency).toBe(150)
    expect(stats.avgLoss).toBeCloseTo(100 / 3)
    expect(stats.availability).toBeCloseTo(200 / 3)
    expect(stats.p50Latency).toBe(150)
    expect(stats.hasLatencyData).toBe(true)
  })

  test('prefers metric aggregates and normalizes carrier filters', () => {
    const metricStats: PingMetricTaskStats[] = [{
      task_id: '1',
      total: 10,
      valid: 9,
      avg: 50,
      latest: 52,
      loss: 10,
      loss_approximate: false,
      p50: 48,
      p99: 90,
      p99_p50_ratio: 1.875,
    }]

    const stats = buildNodePingStats([], metricStats)
    expect(stats.sampleCount).toBe(10)
    expect(stats.avgLatency).toBe(50)
    expect(stats.avgLoss).toBe(10)
    expect(stats.availability).toBe(90)
    expect(normalizePingTaskFilter('中国-电 信')).toBe('中国电信')
    expect(matchesPingTaskName('北京-电信', '北京电信')).toBe(true)
    expect(matchesPingTaskName('北京-电信', '北京电信', true)).toBe(false)
    expect(matchesPingTaskName(' 北京电信 ', '北京电信', true)).toBe(true)
    expect(createEmptyNodePingStats().hasData).toBe(false)
  })

  test('keeps total loss data without inventing zero latency', () => {
    const stats = buildNodePingStats([], [{
      task_id: '1',
      total: 10,
      valid: 0,
      latest: 0,
      loss: 100,
      loss_approximate: false,
      tags: {},
    }])

    expect(stats.hasData).toBe(true)
    expect(stats.hasLatencyData).toBe(false)
    expect(stats.avgLoss).toBe(100)
  })

  test('scopes same-named task candidates to the current source node', () => {
    const taskClients = new Map([
      [1, new Set(['node-a'])],
      [2, new Set(['node-b'])],
    ])

    expect([...collectNodePingTaskIds('node-a', [], [], [], taskClients)]).toEqual([1])
    expect([...collectNodePingTaskIds('node-b', [], [], [], taskClients)]).toEqual([2])
  })

  test('collects task ids from legacy ping records', () => {
    const records: PingRecord[] = [
      { client: 'node-a', task_id: 7, time: '2026-08-15T00:00:00.000Z', value: 100 },
      { client: 'node-a', task_id: 9, time: '2026-08-15T00:01:00.000Z', value: 120 },
    ]

    expect([...collectNodePingTaskIds('node-a', records)].sort()).toEqual([7, 9])
  })

  test('collects task ids from metric stats, normalizing numeric and non-numeric ids', () => {
    const metricStats: Pick<PingMetricTaskStats, 'task_id'>[] = [
      { task_id: '5' },
      { task_id: 'metric-task-abc' },
    ]

    const ids = collectNodePingTaskIds('node-a', [], metricStats)
    expect(ids.has(5)).toBe(true)
    expect(ids.has(hashTaskId('metric-task-abc'))).toBe(true)
    expect(ids.size).toBe(2)
  })

  test('collects task ids from metric loss points', () => {
    const metricLossPoints: Pick<MetricLossPoint, 'taskId'>[] = [
      { taskId: 11 },
      { taskId: 13 },
    ]

    expect([...collectNodePingTaskIds('node-a', [], [], metricLossPoints)].sort()).toEqual([11, 13])
  })

  test('merges and dedupes task ids across every source', () => {
    const records: PingRecord[] = [
      { client: 'node-a', task_id: 1, time: '2026-08-15T00:00:00.000Z', value: 100 },
    ]
    const metricStats: Pick<PingMetricTaskStats, 'task_id'>[] = [{ task_id: '1' }, { task_id: '2' }]
    const metricLossPoints: Pick<MetricLossPoint, 'taskId'>[] = [{ taskId: 2 }, { taskId: 3 }]
    const taskClients = new Map([[3, new Set(['node-a'])], [4, new Set(['node-a'])]])

    const ids = collectNodePingTaskIds('node-a', records, metricStats, metricLossPoints, taskClients)
    expect([...ids].sort((left, right) => left - right)).toEqual([1, 2, 3, 4])
  })
})

describe('buildPingMetricState (Metric Store vs. legacy fallback gate)', () => {
  test('falls back to legacy when there is no metrics query response at all', () => {
    expect(buildPingMetricState(nodeUuid, statsResponse([pingStat()]), null)).toBeNull()
  })

  test('falls back to legacy when an exact-loss task has no matching loss series', () => {
    // stats say task 1 has a real (non-approximate) loss reading, but the
    // metrics query never returned a ping.loss series for it — trusting the
    // Metric Store here would silently hide that task's real loss.
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([pingStat({ task_id: '1' })]),
      metricsResponse([latencySeries('1')]),
    )
    expect(result).toBeNull()
  })

  test('falls back to legacy when there is no exact-loss stat to begin with', () => {
    // Only an approximate-loss stat exists; nothing to corroborate against a
    // loss series, so there is nothing "complete" to trust.
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([pingStat({ task_id: '1', loss_approximate: true })]),
      metricsResponse([latencySeries('1'), lossSeries('1')]),
    )
    expect(result).toBeNull()
  })

  test('trusts the Metric Store once every exact-loss task has a matching loss series', () => {
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([pingStat({ task_id: '1' })]),
      metricsResponse([latencySeries('1'), lossSeries('1')]),
    )
    expect(result?.source).toBe('metric')
    expect(result?.metricLossPoints).toHaveLength(1)
  })

  test('does not require a matching series for an approximate-loss task', () => {
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([
        pingStat({ task_id: '1' }),
        pingStat({ task_id: '2', loss_approximate: true }),
      ]),
      metricsResponse([latencySeries('1'), lossSeries('1')]),
    )
    expect(result?.source).toBe('metric')
  })

  test('ignores stats and series belonging to a different node', () => {
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([pingStat({ entity_id: 'node-b', task_id: '1' })]),
      metricsResponse([{ ...latencySeries('1'), entity_id: 'node-b' }, { ...lossSeries('1'), entity_id: 'node-b' }]),
    )
    // No exact-loss stats for nodeUuid itself, so nothing to trust.
    expect(result).toBeNull()
  })

  test('drops loss points with a non-finite value instead of trusting them', () => {
    const result = buildPingMetricState(
      nodeUuid,
      statsResponse([pingStat({ task_id: '1' })]),
      metricsResponse([latencySeries('1'), lossSeries('1', [{ time: '2026-08-15T00:00:00.000Z', value: Number.NaN }])]),
    )
    // The only loss point is non-finite, so metricLossTaskIds never gets '1'
    // and the series is treated as missing.
    expect(result).toBeNull()
  })
})

describe('pickPreferredExactPingTaskId', () => {
  test('prefers the healthy duplicate over a dead same-named task', () => {
    expect(pickPreferredExactPingTaskId(new Set([10, 11]), {
      metricStats: [
        pingStat({ task_id: '10', total: 40, valid: 0 }),
        pingStat({ task_id: '11', total: 40, valid: 40 }),
      ],
    })).toBe(11)
  })

  test('prefers a pending replacement over a dead original when stats only cover the original', () => {
    expect(pickPreferredExactPingTaskId(new Set([10, 11]), {
      metricStats: [pingStat({ task_id: '10', total: 40, valid: 0 })],
    })).toBe(11)
  })

  test('breaks remaining ties with the higher task id', () => {
    expect(pickPreferredExactPingTaskId(new Set([10, 12, 11]))).toBe(12)
  })
})
