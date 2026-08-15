import type { MetricSeries, StatusRecord } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { metricSeriesToChartRecords, statusRecordsToChartRecords } from '../../src/utils/loadMetricRecords'

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
    expect(records[0]).toMatchObject({ client: 'node-1', cpu: 42, gpu: 75, gpu_usage: 75 })
    expect(records[0]?.gpu_detailed?.[0]).toMatchObject({ device_name: 'GPU A', memory: 75 })
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
      gpu_detailed: { 0: { usage: 50, memory: 50 } },
    })
  })
})
