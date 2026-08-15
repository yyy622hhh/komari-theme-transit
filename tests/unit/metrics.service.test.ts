import { describe, expect, test } from 'bun:test'
import { partitionMetricEntityIds } from '../../src/services/metrics.service'

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
