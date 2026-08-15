import { describe, expect, test } from 'bun:test'
import { getQueryMetricsRequestKey, partitionMetricEntityIds } from '../../src/services/metrics.service'

describe('partitionMetricEntityIds', () => {
  test('deduplicates entity ids and caps each request batch', () => {
    const entityIds = Array.from({ length: 51 }, (_, index) => `node-${index + 1}`)
    entityIds.push('node-1', ' ', '')

    const batches = partitionMetricEntityIds(entityIds)

    expect(batches.map(batch => batch.length)).toEqual([50, 1])
    expect(batches.flat()).toHaveLength(51)
    expect(new Set(batches.flat()).size).toBe(51)
  })

  test('normalizes an invalid custom batch size to one', () => {
    expect(partitionMetricEntityIds([' node-1 ', 'node-2'], Number.NaN)).toEqual([
      ['node-1'],
      ['node-2'],
    ])
  })
})

describe('getQueryMetricsRequestKey', () => {
  test('includes every per-metric downsampling result dimension', () => {
    const baseline = { entity_id: 'node-1', metric_keys: ['cpu.usage'] }
    const keys = [
      getQueryMetricsRequestKey({ ...baseline, max_points_by_metric: { 'cpu.usage': 60 } }),
      getQueryMetricsRequestKey({ ...baseline, points_by_metric: { 'cpu.usage': 60 } }),
      getQueryMetricsRequestKey({ ...baseline, aggregation_by_metric: { 'cpu.usage': 'avg' } }),
      getQueryMetricsRequestKey({ ...baseline, algorithm_by_metric: { 'cpu.usage': 'lttb' } }),
    ]

    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain(getQueryMetricsRequestKey(baseline))
  })

  test('serializes nested maps independently of object insertion order', () => {
    const left = getQueryMetricsRequestKey({ tags: { region: 'US', device: { index: 0, name: 'GPU' } } })
    const right = getQueryMetricsRequestKey({ tags: { device: { name: 'GPU', index: 0 }, region: 'US' } })
    expect(left).toBe(right)
  })
})
