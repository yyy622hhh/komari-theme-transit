import { afterEach, expect, test } from 'bun:test'
import { invalidatePublicPingTasksCache } from '../../src/services/metrics.service'
import { getSharedPingRecordsEntry, loadSharedPingRecords, retainSharedPingRecordsEntry } from '../../src/services/nodePingRecords.shared'
import { loadPingMetricBatch } from '../../src/services/ping-metric-batch.service'
import { buildNodePingStats } from '../../src/utils/pingStats'
import { resetSharedRpc } from '../../src/utils/rpc'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  invalidatePublicPingTasksCache()
  resetSharedRpc()
})

for (const failedCount of [51, 30, 31]) {
  test(`51-node batch uses a single fleet denominator (${failedCount} failed)`, async () => {
    const clients = Array.from({ length: 51 }, (_, index) => `boundary-${failedCount}-${index}`)
    const failures = new Set(clients.slice(0, failedCount))
    const time = new Date(Date.now() - 30_000).toISOString()
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const ids: string[] = request.params?.entity_ids ?? []
      let result: unknown
      if (request.method === 'public:getPublicPingTasks')
        result = [{ id: 88, name: '北京电信', clients, type: 'icmp', interval: 30 }]
      else if (request.method === 'public:getPingMetricStats')
        result = { start: time, end: time, count: ids.length, stats: ids.map(entity_id => ({ entity_id, task_id: '88', total: 3, valid: failures.has(entity_id) ? 0 : 3, loss: failures.has(entity_id) ? 100 : 0, loss_approximate: false, tags: {} })) }
      else if (request.method === 'public:queryMetrics')
        result = { start: time, end: time, count: ids.length, series: ids.map(entity_id => ({ entity_id, metric_key: 'ping.loss', tags: { task_id: '88' }, downsampled: false, points: [{ time, value: failures.has(entity_id) ? 1 : 0, count: 1 }] })) }
      else
        throw new Error(`Unexpected ${request.method}`)
      return Response.json({ jsonrpc: '2.0', id: request.id, result })
    }) as typeof fetch
    const releases = clients.map(uuid => retainSharedPingRecordsEntry(1, 20, uuid))
    try {
      await Promise.all(clients.map(uuid => loadSharedPingRecords(getSharedPingRecordsEntry(1, 20, uuid), 1, 20, uuid)))
      for (const uuid of clients) {
        const state = getSharedPingRecordsEntry(1, 20, uuid).data.value!
        const stats = buildNodePingStats(state.recordsByClient.get(uuid) ?? [], state.metricStats, state.metricLossPoints)
        const commonMode = failedCount / 51 >= 0.6
        expect(state.metricLossPoints![0]!.commonMode).toBe(commonMode)
        expect(stats.lineLoss).toBe(failures.has(uuid) && !commonMode ? 100 : 0)
      }
    }
    finally {
      releases.forEach(release => release())
    }
  })
}

test('a failed transport partition cannot turn the remaining minority into a common outage', async () => {
  const clients = Array.from({ length: 51 }, (_, index) => `partial-${index}`)
  const time = new Date().toISOString()
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const ids: string[] = request.params?.entity_ids ?? []
    const result = request.method === 'public:getPingMetricStats'
      ? { stats: [] }
      : ids.length === 1
        ? { series: [null] }
        : { series: ids.map(entity_id => ({ entity_id, metric_key: 'ping.loss', tags: { task_id: '88' }, points: [{ time, value: 1 }], downsampled: false })) }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }) as typeof fetch
  const results = await Promise.all(clients.map(uuid => loadPingMetricBatch(uuid, 1, 20)))
  expect(results.every(result => result?.commonModeKeys.size === 0)).toBeTrue()
})

for (const malformed of ['stats', 'series', 'points']) {
  test(`malformed ${malformed} settles loading, falls back and permits the next refresh`, async () => {
    let corrupt = true
    let statsCalls = 0
    let fallbackCalls = 0
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      let result: unknown = { series: [], count: 0 }
      if (request.method === 'public:getPublicPingTasks')
        result = []
      if (request.method === 'public:getPingMetricStats') {
        statsCalls++
        result = { stats: corrupt && malformed === 'stats' ? [null] : [] }
      }
      if (request.method === 'public:queryMetrics' && corrupt && malformed !== 'stats')
        result = { series: malformed === 'series' ? [null] : [{ entity_id: 'node', metric_key: 'ping.loss', points: [null] }] }
      if (request.method === 'common:getRecords') {
        fallbackCalls++
        result = { records: [], tasks: [] }
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result })
    }) as typeof fetch
    const uuid = `malformed-${malformed}`
    const release = retainSharedPingRecordsEntry(1, 20, uuid)
    const entry = getSharedPingRecordsEntry(1, 20, uuid)
    try {
      await loadSharedPingRecords(entry, 1, 20, uuid)
      expect(entry.loading.value).toBeFalse()
      expect(entry.promise).toBeNull()
      expect(entry.data.value?.source).toBe('legacy')
      expect(fallbackCalls).toBe(1)
      corrupt = false
      await loadSharedPingRecords(entry, 1, 20, uuid)
      expect(statsCalls).toBe(2)
      expect(entry.loading.value).toBeFalse()
    }
    finally {
      release()
    }
  })
}

test('unmount/remount during metrics loading never starts a legacy fallback on the old aborted request', async () => {
  let releaseStats!: () => void
  let started!: () => void
  const statsStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let statsCalls = 0
  let legacyCalls = 0
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === 'public:getPingMetricStats' && ++statsCalls === 1) {
      await new Promise<void>((resolve) => {
        releaseStats = resolve
        started()
      })
    }
    if (request.method === 'common:getRecords') {
      legacyCalls++
      expect(init?.signal?.aborted).toBeFalse()
    }
    const result = request.method === 'public:getPublicPingTasks' ? [] : { stats: [], series: [], records: [], tasks: [] }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }) as typeof fetch
  const uuid = 'remount-regression'
  const releaseFirst = retainSharedPingRecordsEntry(1, 20, uuid)
  const entry = getSharedPingRecordsEntry(1, 20, uuid)
  const old = loadSharedPingRecords(entry, 1, 20, uuid)
  await statsStarted
  releaseFirst()
  const releaseSecond = retainSharedPingRecordsEntry(1, 20, uuid)
  try {
    const replacement = loadSharedPingRecords(entry, 1, 20, uuid)
    releaseStats()
    await Promise.all([old, replacement])
    expect(statsCalls).toBe(2)
    expect(legacyCalls).toBe(1)
    expect(entry.loading.value).toBeFalse()
    expect(entry.error.value).toBeNull()
  }
  finally {
    releaseSecond()
  }
})
