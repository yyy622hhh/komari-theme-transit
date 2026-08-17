import type { PingMetricTaskStats, PingRecord } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { collectNodePingTaskIds } from '../../src/composables/useNodePingStats'
import { buildNodePingStats, createEmptyNodePingStats, matchesPingTaskName, normalizePingTaskFilter } from '../../src/utils/pingStats'

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
})
