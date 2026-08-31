import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { mergeCarrierPingStats, useNodeCarrierPingStats } from '../../src/composables/useNodePingStats'
import { PING_RECORD_MAX_COUNT } from '../../src/constants/load'
import { getSharedPingRecordsEntry, pingFreshnessTick } from '../../src/services/nodePingRecords.shared'
import { buildNodePingStats, createEmptyNodePingStats } from '../../src/utils/pingStats'

const now = Date.now()
function stats(taskId: number, values: number[]) {
  return buildNodePingStats(values.map((value, index) => ({
    client: 'node',
    task_id: taskId,
    value,
    time: new Date(now - (values.length - index) * 30000).toISOString(),
  })))
}
describe('carrier display aggregation', () => {
  test('an old regional outage is not shifted into the latest history bar', () => {
    const old = { ...stats(1, [-1]), history: [{ time: new Date(now - 3_000_000).toISOString(), latency: null, loss: 100 }] }
    const recent = stats(2, [100])
    const combined = mergeCarrierPingStats([old, recent])
    expect(combined.history).toHaveLength(2)
    expect(combined.history[0]?.loss).toBe(100)
    expect(combined.history.at(-1)?.loss).toBe(0)
    expect(combined.history.at(-1)?.latency).toBe(100)
  })
  test('all-failed regions never contribute zero-ms latency or jitter', () => {
    const good = stats(1, [100, 100, 100])
    const combined = mergeCarrierPingStats([good, stats(2, [-1, -1, -1])])
    expect(combined).toMatchObject({ avgLatency: 100, avgLoss: 50, availability: 50, latencySampleCount: 3, hasLatencyData: true })
    expect(combined.avgVolatility).toBe(good.avgVolatility)
  })
  test('latency weights use successes, while failure rates use every sample', () => {
    const combined = mergeCarrierPingStats([stats(1, [100, -1, -1]), stats(2, [200, 200, 200])])
    expect(combined.avgLatency).toBe(175)
    expect(combined.latencySampleCount).toBe(4)
    expect(combined.avgLoss).toBeCloseTo(100 / 3)
    expect(combined.availability).toBeCloseTo(200 / 3)
  })
  test('all failures and empty regions remain without latency', () => {
    expect(mergeCarrierPingStats([stats(1, [-1]), stats(2, [-1]), createEmptyNodePingStats()])).toMatchObject({
      hasLatencyData: false,
      avgLoss: 100,
      latencySampleCount: 0,
      availability: 0,
    })
    expect(mergeCarrierPingStats([])).toEqual(createEmptyNodePingStats())
  })
})

for (const carrier of ['电信', '联通', '移动']) {
  for (const region of ['广东', '广州']) {
    test(`${region}${carrier} is displayed in Guangdong and all-regions mode without mixing duplicate histories`, () => {
      const uuid = `alias-${region}-${carrier}`
      const entry = getSharedPingRecordsEntry(1, PING_RECORD_MAX_COUNT, uuid)
      const name = `${region}${carrier}`
      const records = [1, 2].flatMap(id => [60, 30, 0].map(age => ({ client: uuid, task_id: id, value: id === 1 ? -1 : 100, time: new Date(now - age * 1000).toISOString() })))
      entry.data.value = {
        recordsByClient: new Map([[uuid, records]]),
        source: 'legacy',
        rawRecordsByClient: new Map([[uuid, records]]),
        sampleUpdatedAtByTaskId: new Map([[1, now], [2, now]]),
        taskNamesById: new Map([[1, `广东${carrier}`], [2, name]]),
        taskClientsById: new Map([[1, new Set([uuid])], [2, new Set([uuid])]]),
        taskTypesById: new Map([[1, 'icmp'], [2, 'icmp']]),
        taskIntervalsById: new Map([[1, 30], [2, 30]]),
      }
      entry.lastFetchedAt = Date.now()
      for (const filter of ['广东', '']) {
        const scope = effectScope()
        const previousTick = pingFreshnessTick.value
        try {
          pingFreshnessTick.value = now
          const display = scope.run(() => useNodeCarrierPingStats(uuid, { hours: 1, taskNameFilter: filter }))!
          const result = display.carriers.value.find(item => item.labelZh === carrier)!
          expect(result.stats).toMatchObject({ hasData: true, avgLatency: 100, avgLoss: 0, sampleCount: 3 })
          expect(result.current.status).toBe('healthy')
        }
        finally {
          scope.stop()
          pingFreshnessTick.value = previousTick
        }
      }
    })
  }
}
