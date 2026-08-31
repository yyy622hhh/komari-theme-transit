import { afterEach, describe, expect, mock, test } from 'bun:test'
import { getQueryMetricsRequestKey, invalidatePublicPingTasksCache, loadPingTaskNamesForNode, loadPublicPingTasks, partitionMetricEntityIds } from '../../src/services/metrics.service'
import { resetSharedRpc } from '../../src/utils/rpc'

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

afterEach(() => {
  invalidatePublicPingTasksCache()
  mock.restore()
  resetSharedRpc()
})

for (const oldFinishesFirst of [true, false]) {
  test(`invalidated in-flight public task lists cannot be returned or recached (old first: ${oldFinishesFirst})`, async () => {
    invalidatePublicPingTasksCache()
    const originalFetch = globalThis.fetch
    const tasks = (id: number) => [{ id, name: '北京电信', clients: ['cache-node'], interval: 30, type: 'icmp' }]
    let requests = 0
    let releaseOld!: () => void
    let releaseNew!: () => void
    globalThis.fetch = (async (_url, init) => {
      const rpc = JSON.parse(String(init?.body))
      const index = ++requests
      await new Promise<void>((resolve) => {
        if (index === 1)
          releaseOld = resolve
        else
          releaseNew = resolve
      })
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: tasks(index === 1 ? 10 : 11) })
    }) as typeof fetch
    try {
      const old = loadPublicPingTasks()
      invalidatePublicPingTasksCache()
      const current = loadPublicPingTasks()
      expect(requests).toBe(2)
      if (oldFinishesFirst) {
        releaseOld()
        await new Promise(resolve => setTimeout(resolve, 0))
        releaseNew()
      }
      else {
        releaseNew()
        await current
        releaseOld()
      }
      expect(await old).toEqual(tasks(11))
      expect(await current).toEqual(tasks(11))
      expect(await loadPublicPingTasks()).toEqual(tasks(11))
      expect(requests).toBe(2)
    }
    finally {
      releaseOld?.()
      releaseNew?.()
      globalThis.fetch = originalFetch
    }
  })
}

describe('loadPingTaskNamesForNode', () => {
  test('uses explicit Komari client assignments instead of default_on as a global flag', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number, method: string }
      const result = request.method === 'public:getPublicPingTasks'
        ? [
            { id: 1, name: 'new-node-default', default_on: true, clients: ['another-node'] },
            { id: 2, name: 'empty-assignment', clients: [] },
            { id: 3, name: 'assigned', clients: ['node-1'] },
          ]
        : { stats: [], count: 0, start: '', end: '', interval_seconds: 60 }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await expect(loadPingTaskNamesForNode('node-1')).resolves.toEqual(['assigned'])
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
