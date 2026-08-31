import { describe, expect, test } from 'bun:test'
import { rawPingQueryStart } from '../../src/services/ping-raw-samples.service'
import { formatProbeCurrentCompactLabel, formatProbeCurrentLabel, hasCurrentCommonModeFailure, normalizeRawPingSamples, probeCurrentTone, probeFailureRateLabel, rawPingSamplesFromMetrics, resolveProbeCurrentState } from '../../src/utils/pingCurrentState'

const now = Date.now()
const records = (values: number[], client = 'a', id = 1) => values.map((value, index) => ({ client, task_id: id, value, time: new Date(now - (values.length - index) * 30_000).toISOString() }))

describe('current probe state is separate from the historical window', () => {
  test('historical failures only add a recovery label when fresh raw samples prove health', () => {
    expect(formatProbeCurrentCompactLabel('healthy', true)).toBe('已恢复')
    expect(formatProbeCurrentCompactLabel('healthy', false)).toBe('正常')
    expect(formatProbeCurrentLabel('healthy', true)).toBe('正常（已恢复）')
    expect(formatProbeCurrentLabel('healthy', false)).toBe('正常')
    for (const status of ['failed', 'intermittent', 'stale', 'insufficient', 'offline'] as const)
      expect(formatProbeCurrentLabel(status, true)).not.toContain('已恢复')
    expect(probeFailureRateLabel('tcp')).toBe('探测失败率')
    expect(probeFailureRateLabel('')).toBe('探测失败率')
    expect(probeFailureRateLabel('icmp')).toBe('ICMP 丢包率')
  })
  test('compact labels preserve failure and unknown states, with distinct current-state tones', () => {
    for (const status of ['failed', 'intermittent', 'stale', 'insufficient', 'offline'] as const)
      expect(formatProbeCurrentCompactLabel(status, true)).toBe(formatProbeCurrentLabel(status))
    expect(probeCurrentTone('failed')).not.toBe(probeCurrentTone('healthy'))
    expect(probeCurrentTone('intermittent')).not.toBe(probeCurrentTone('failed'))
    expect(probeCurrentTone('stale')).toBe(probeCurrentTone('insufficient'))
    expect(probeCurrentTone('offline')).not.toBe(probeCurrentTone('failed'))
  })
  test('raw query stays inside the backend exact retention window and honors creation time', () => {
    expect(now - rawPingQueryStart(now - 3_600_000, now)).toBeLessThan(600_000)
    expect(rawPingQueryStart(now - 90_000, now)).toBe(now - 90_000)
  })
  test('recovery is based on the last three raw samples, not the hourly failure rate', () => {
    expect(resolveProbeCurrentState(records([-1, -1, -1, -1, 12, 12, 12]), { now }).status).toBe('healthy')
    expect(resolveProbeCurrentState(records([12, 12, 12, 12, -1, -1, -1]), { now }).status).toBe('failed')
    expect(resolveProbeCurrentState(records([12, -1, 12]), { now }).status).toBe('intermittent')
  })
  test('missing, stale, and offline are not target failures', () => {
    expect(resolveProbeCurrentState(records([12]), { now }).status).toBe('insufficient')
    expect(resolveProbeCurrentState(records([12, 12, 12]), { now: now + 180_001 }).status).toBe('stale')
    expect(resolveProbeCurrentState(records([-1, -1, -1]), { now, online: false }).status).toBe('offline')
  })
  test('deduplicates, orders, excludes pre-creation and future samples', () => {
    const raw = records([1, 2, 3])
    expect(normalizeRawPingSamples([raw[2]!, raw[0]!, raw[2]!, raw[1]!], now - 60_000, now)).toHaveLength(2)
    expect(normalizeRawPingSamples([{ ...raw[0]!, time: new Date(now + 1).toISOString() }], 0, now)).toEqual([])
  })
  test('downsampled and multi-count metrics cannot establish a success streak', () => {
    const series: any = { metric_key: 'ping.latency_ms', entity_id: 'a', tags: { task_id: '1' }, downsampled: true, points: [{ time: new Date(now).toISOString(), value: 12, count: 3 }] }
    expect(rawPingSamplesFromMetrics([series])).toEqual([])
    expect(rawPingSamplesFromMetrics([{ ...series, downsampled: false }])).toEqual([])
    expect(rawPingSamplesFromMetrics([{ ...series, downsampled: false, tags: {}, points: [{ ...series.points[0], count: 1, tags: { task_id: '2' } }] }])).toMatchObject([{ task_id: 2, value: 12 }])
  })
  test('current synchronized failures require five nodes and 60%, and clear on recovery', () => {
    const clients = Array.from({ length: 8 }, (_, i) => `n${i}`)
    const failed = clients.flatMap((client, i) => records(i < 5 ? [-1, -1, -1] : [1, 1, 1], client))
    expect(hasCurrentCommonModeFailure(failed, clients, 30, now)).toBeTrue()
    expect(hasCurrentCommonModeFailure(failed, [...clients, 'n8'], 30, now)).toBeTrue() // missing node is not an observed failure
    expect(hasCurrentCommonModeFailure(clients.flatMap(client => records([-1, 1, 1, 1], client)), clients, 30, now)).toBeFalse()
    expect(hasCurrentCommonModeFailure(failed.filter(record => record.client !== 'n4'), clients, 30, now)).toBeFalse()
  })
})
