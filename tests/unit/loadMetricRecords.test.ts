import type { MetricSeries, StatusRecord } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { metricSeriesToChartRecords, recordHasLoadSample, statusRecordsToChartRecords } from '../../src/utils/loadMetricRecords'

function series(metricKey: string, value: number, tags: Record<string, unknown> = {}): MetricSeries {
  return {
    metric_key: metricKey,
    entity_id: 'node-1',
    tags,
    downsampled: false,
    count: 1,
    points: [{ time: '2026-08-14T00:00:00.000Z', value }],
  }
}

describe('load metric record normalization', () => {
  test('combines metric series and derives GPU memory percentage', () => {
    const records = metricSeriesToChartRecords([
      series('cpu.usage', 42),
      series('gpu.device.usage', 75, { device_index: 0, device_name: 'GPU A' }),
      series('gpu.memory.used', 6, { device_index: 0 }),
      series('gpu.memory.total', 8, { device_index: 0 }),
    ], { uuid: 'node-1', memoryTotal: 16, diskTotal: 100 })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ client: 'node-1', cpu: 42, gpu: 75, gpu_usage: 75, gpu_memory: 75 })
    expect(records[0]?.gpu_detailed?.[0]).toMatchObject({ device_name: 'GPU A', memory: 75 })
  })

  test('averages per-device GPU usage instead of keeping only the first card', () => {
    const records = metricSeriesToChartRecords([
      series('gpu.device.usage', 40, { device_index: 0 }),
      series('gpu.device.usage', 80, { device_index: 1 }),
    ], { uuid: 'node-1' })

    expect(records[0]?.gpu_usage).toBe(60)
    expect(records[0]?.gpu).toBe(60)
  })

  test('keeps a legitimate idle GPU reading of 0% when there are no device series', () => {
    const records = metricSeriesToChartRecords([
      series('gpu.usage', 0),
    ], { uuid: 'node-1' })

    expect(records[0]?.gpu_usage).toBe(0)
    expect(records[0]?.gpu).toBe(0)
  })

  test('does not let an idle aggregate GPU reading hide per-device usage', () => {
    const records = metricSeriesToChartRecords([
      series('gpu.usage', 0),
      series('gpu.device.usage', 40, { device_index: 0 }),
      series('gpu.device.usage', 80, { device_index: 1 }),
    ], { uuid: 'node-1' })

    expect(records[0]?.gpu_usage).toBe(60)
    expect(records[0]?.gpu).toBe(60)
  })

  test('preserves recent status GPU details', () => {
    const status = {
      client: 'node-1',
      time: '2026-08-14T00:00:00.000Z',
      cpu: 10,
      gpu: 20,
      gpu_average_usage: 30,
      gpu_detailed_info: [{ device_index: 0, utilization: 50, memory_used: 4, memory_total: 8 }],
    } as StatusRecord

    expect(statusRecordsToChartRecords([status])[0]).toMatchObject({
      cpu: 10,
      gpu: 30,
      gpu_usage: 30,
      gpu_memory: 50,
      gpu_detailed: { 0: { usage: 50, memory: 50 } },
    })
  })

  test('treats non-CPU load samples as usable history', () => {
    const records = metricSeriesToChartRecords([
      series('memory.used', 8),
      series('net.in.rate', 12),
    ], { uuid: 'node-1' })

    expect(records[0]?.cpu).toBeNull()
    expect(recordHasLoadSample(records[0]!)).toBe(true)
    expect(recordHasLoadSample({
      client: 'node-1',
      time: '2026-08-14T00:00:00.000Z',
      cpu: null,
      gpu: null,
      gpu_usage: null,
      gpu_memory: null,
      ram: null,
      ram_total: null,
      swap: null,
      swap_total: null,
      load: null,
      temp: null,
      disk: null,
      disk_total: null,
      net_in: null,
      net_out: null,
      net_total_up: null,
      net_total_down: null,
      traffic_up: null,
      traffic_down: null,
      process: null,
      connections: null,
      connections_udp: null,
    })).toBe(false)
  })
})
