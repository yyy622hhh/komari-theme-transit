import type { SharedPingRecordsState } from '../../src/services/nodePingRecords.shared'
import type { PingRecord } from '../../src/utils/rpcTypes'
import { afterEach, describe, expect, test } from 'bun:test'
import { effectScope, nextTick } from 'vue'
import { useNodeCarrierPingStats, useNodePingStats } from '../../src/composables/useNodePingStats'
import { getSharedPingRecordsEntry, pingFreshnessGraceUntil, pingFreshnessTick } from '../../src/services/nodePingRecords.shared'

// 这个 composable 从共享缓存条目（entry.data）派生所有统计，不直接发请求。
// 直接把 entry.data 和 entry.lastFetchedAt 填好，就能让 watch 里的
// `shouldLoadRecords` 判定为 false，从而完全绕开真实网络请求——不需要 mock fetch。

let uuidCounter = 0
function uniqueUuid(): string {
  uuidCounter += 1
  return `ping-stats-spike-${uuidCounter}`
}

function pingRecord(taskId: number, uuid: string, value: number, time: string): PingRecord {
  return { client: uuid, task_id: taskId, time, value }
}

function sharedState(overrides: Partial<SharedPingRecordsState> = {}): SharedPingRecordsState {
  return {
    recordsByClient: new Map(),
    source: 'legacy',
    sampleUpdatedAtByTaskId: new Map(),
    taskNamesById: new Map(),
    taskClientsById: new Map(),
    ...overrides,
  }
}

function seedEntry(uuid: string, hours: number, maxCount: number, state: SharedPingRecordsState, lastFetchedAt = Date.now()) {
  const entry = getSharedPingRecordsEntry(hours, maxCount, uuid)
  entry.data.value = state
  entry.lastFetchedAt = lastFetchedAt
  return entry
}

function mountPingStats(uuid: string, options: Parameters<typeof useNodePingStats>[1]) {
  const scope = effectScope()
  const composable = scope.run(() => useNodePingStats(uuid, options))!
  return { composable, scope }
}

describe('disabled or unresolved node', () => {
  test('a disabled composable reports empty stats without reading the shared cache', async () => {
    const uuid = uniqueUuid()
    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100, enabled: false })
    await nextTick()
    expect(composable.stats.value.hasData).toBe(false)
    expect(composable.taskNames.value).toEqual([])
    expect(composable.selectedTaskId.value).toBeNull()
    scope.stop()
  })

  test('a blank uuid reports empty stats even when enabled', async () => {
    const { composable, scope } = mountPingStats('   ', { hours: 24, maxCount: 100 })
    await nextTick()
    expect(composable.stats.value.hasData).toBe(false)
    scope.stop()
  })
})

describe('live derivation from a seeded shared entry', () => {
  test('a contains filter that matches exactly one task selects it and builds stats from its records', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [
        pingRecord(1, uuid, 42, new Date(now - 60_000).toISOString()),
        pingRecord(1, uuid, 44, new Date(now).toISOString()),
      ]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now]]),
      taskNamesById: new Map([[1, '北京电信']]),
      taskClientsById: new Map([[1, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100, taskNameFilter: '电信' })
    await nextTick()

    expect(composable.selectedTaskId.value).toBe(1)
    expect(composable.selectedTaskName.value).toBe('北京电信')
    expect(composable.taskNames.value).toEqual(['北京电信'])
    expect(composable.stats.value.hasData).toBe(true)
    expect(composable.stats.value.sampleCount).toBe(2)
    scope.stop()
  })

  test('an unrelated filter yields no match and reports empty stats even though the node has data', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [pingRecord(1, uuid, 42, new Date(now).toISOString())]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now]]),
      taskNamesById: new Map([[1, '北京电信']]),
      taskClientsById: new Map([[1, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100, taskNameFilter: '上海移动' })
    await nextTick()

    expect(composable.taskNames.value).toEqual([])
    expect(composable.stats.value.hasData).toBe(false)
    scope.stop()
  })

  test('an empty filter aggregates every task instead of narrowing to one', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [
        pingRecord(1, uuid, 10, new Date(now).toISOString()),
        pingRecord(2, uuid, 20, new Date(now).toISOString()),
      ]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now], [2, now]]),
      taskNamesById: new Map([[1, '北京电信'], [2, '北京联通']]),
      taskClientsById: new Map([[1, new Set([uuid])], [2, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100 })
    await nextTick()

    expect(composable.selectedTaskId.value).toBeNull()
    expect(composable.selectedTaskName.value).toBe('')
    expect([...composable.taskNames.value].sort()).toEqual(['北京电信', '北京联通'])
    expect(composable.stats.value.sampleCount).toBe(2)
    scope.stop()
  })

  test('only counts a task toward this node when it is actually assigned or sampled here', async () => {
    const uuid = uniqueUuid()
    const otherUuid = uniqueUuid()
    const now = Date.now()
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[otherUuid, [pingRecord(1, otherUuid, 10, new Date(now).toISOString())]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now]]),
      taskNamesById: new Map([[1, '别的节点的任务']]),
      taskClientsById: new Map([[1, new Set([otherUuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100 })
    await nextTick()

    expect(composable.taskNames.value).toEqual([])
    expect(composable.stats.value.hasData).toBe(false)
    scope.stop()
  })
})

describe('freshness', () => {
  const originalTick = pingFreshnessTick.value
  const originalGrace = pingFreshnessGraceUntil.value

  afterEach(() => {
    pingFreshnessTick.value = originalTick
    pingFreshnessGraceUntil.value = originalGrace
  })

  test('reports fresh right after a sample lands', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    pingFreshnessTick.value = now
    pingFreshnessGraceUntil.value = 0
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [pingRecord(1, uuid, 10, new Date(now).toISOString())]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now]]),
      taskNamesById: new Map([[1, 'task']]),
      taskClientsById: new Map([[1, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100 })
    await nextTick()

    expect(composable.freshness.value).toBe('fresh')
    expect(composable.delayed.value).toBe(false)
    expect(composable.stale.value).toBe(false)
    scope.stop()
  })

  test('reports stale once the freshest sample is far enough in the past', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    pingFreshnessTick.value = now
    pingFreshnessGraceUntil.value = 0
    const staleSampleAt = now - 40 * 60_000
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [pingRecord(1, uuid, 10, new Date(staleSampleAt).toISOString())]]]),
      sampleUpdatedAtByTaskId: new Map([[1, staleSampleAt]]),
      taskNamesById: new Map([[1, 'task']]),
      taskClientsById: new Map([[1, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100 })
    await nextTick()

    expect(composable.stale.value).toBe(true)
    expect(composable.freshnessAgeMs.value).toBeGreaterThanOrEqual(40 * 60_000 - 1_000)
    scope.stop()
  })

  test('reports fresh during the post-resume grace period even for an old sample', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    pingFreshnessTick.value = now
    pingFreshnessGraceUntil.value = now + 60_000
    const staleSampleAt = now - 60 * 60_000
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [pingRecord(1, uuid, 10, new Date(staleSampleAt).toISOString())]]]),
      sampleUpdatedAtByTaskId: new Map([[1, staleSampleAt]]),
      taskNamesById: new Map([[1, 'task']]),
      taskClientsById: new Map([[1, new Set([uuid])]]),
    }))

    const { composable, scope } = mountPingStats(uuid, { hours: 24, maxCount: 100 })
    await nextTick()

    expect(composable.freshness.value).toBe('fresh')
    scope.stop()
  })
})

describe('shared subscription lifecycle', () => {
  test('subscribes to the shared cache entry on mount and releases it when the scope stops', async () => {
    const uuid = uniqueUuid()
    seedEntry(uuid, 24, 100, sharedState())
    const entry = getSharedPingRecordsEntry(24, 100, uuid)
    expect(entry.subscribers).toBe(0)

    const { scope } = mountPingStats(uuid, { hours: 24, maxCount: 100, enabled: true })
    await nextTick()
    expect(entry.subscribers).toBe(1)

    scope.stop()
    expect(entry.subscribers).toBe(0)
  })

  test('does not subscribe at all while disabled', async () => {
    const uuid = uniqueUuid()
    seedEntry(uuid, 24, 100, sharedState())
    const entry = getSharedPingRecordsEntry(24, 100, uuid)

    const { scope } = mountPingStats(uuid, { hours: 24, maxCount: 100, enabled: false })
    await nextTick()
    expect(entry.subscribers).toBe(0)

    scope.stop()
  })
})

describe('useNodeCarrierPingStats', () => {
  test('fans out into three carrier-specific views that share one node’s cache entry', async () => {
    const uuid = uniqueUuid()
    const now = Date.now()
    seedEntry(uuid, 24, 100, sharedState({
      recordsByClient: new Map([[uuid, [
        pingRecord(1, uuid, 10, new Date(now).toISOString()),
        pingRecord(2, uuid, 20, new Date(now).toISOString()),
        pingRecord(3, uuid, 30, new Date(now).toISOString()),
      ]]]),
      sampleUpdatedAtByTaskId: new Map([[1, now], [2, now], [3, now]]),
      taskNamesById: new Map([[1, '北京联通'], [2, '北京电信'], [3, '北京移动']]),
      taskClientsById: new Map([[1, new Set([uuid])], [2, new Set([uuid])], [3, new Set([uuid])]]),
    }))

    const scope = effectScope()
    const carrierStats = scope.run(() => useNodeCarrierPingStats(uuid, { hours: 24, maxCount: 100 }))!
    await nextTick()

    const byKey = new Map(carrierStats.carriers.value.map(carrier => [carrier.key, carrier]))
    expect(byKey.get('unicom')?.taskNames).toEqual(['北京联通'])
    expect(byKey.get('telecom')?.taskNames).toEqual(['北京电信'])
    expect(byKey.get('mobile')?.taskNames).toEqual(['北京移动'])
    expect(byKey.get('unicom')?.stats.hasData).toBe(true)
    expect(carrierStats.loading.value).toBe(false)
    scope.stop()
  })

  test('an empty node reports no data and no error across every carrier', async () => {
    const uuid = uniqueUuid()
    seedEntry(uuid, 24, 100, sharedState())

    const scope = effectScope()
    const carrierStats = scope.run(() => useNodeCarrierPingStats(uuid, { hours: 24, maxCount: 100 }))!
    await nextTick()

    expect(carrierStats.carriers.value.every(carrier => !carrier.hasLatency)).toBe(true)
    expect(carrierStats.error.value).toBeNull()
    scope.stop()
  })
})
