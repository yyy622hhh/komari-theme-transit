import { afterEach, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useNodeCarrierPingDisplay } from '../../src/composables/useNodeCarrierPingDisplay'
import { useNodeCarrierPingStats } from '../../src/composables/useNodePingStats'
import { PING_RECORD_MAX_COUNT } from '../../src/constants/load'
import { getSharedPingRecordsEntry, pingFreshnessTick } from '../../src/services/nodePingRecords.shared'
import { formatPingFreshnessAge } from '../../src/utils/pingFreshness'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const tick = pingFreshnessTick.value
let taskIdCounter = 1_100_000
afterEach(() => {
  pingFreshnessTick.value = tick
  if (originalStorage)
    Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else
    Reflect.deleteProperty(globalThis, 'localStorage')
})

function seed(uuid: string, tasks: Array<{ name: string, at: number, values: number[] }>) {
  const entry = getSharedPingRecordsEntry(1, PING_RECORD_MAX_COUNT, uuid)
  const taskIds = tasks.map(() => ++taskIdCounter)
  const records = tasks.flatMap((task, index) => task.values.map((value, sample) => ({
    client: uuid,
    task_id: taskIds[index]!,
    value,
    time: new Date(task.at - (task.values.length - sample - 1) * 30_000).toISOString(),
  })))
  entry.lastFetchedAt = Date.now()
  entry.data.value = {
    source: 'legacy',
    recordsByClient: new Map([[uuid, records]]),
    taskNamesById: new Map(tasks.map((task, index) => [taskIds[index]!, task.name])),
    sampleUpdatedAtByTaskId: new Map(tasks.map((task, index) => [taskIds[index]!, task.at])),
    taskClientsById: new Map(tasks.map((_, index) => [taskIds[index]!, new Set([uuid])])),
    taskTypesById: new Map(tasks.map((_, index) => [taskIds[index]!, 'icmp'])),
  }
}

test('disabled and empty regions do not contribute epoch-sized freshness ages', () => {
  const now = Date.now()
  pingFreshnessTick.value = now
  seed('freshness-age', [
    { name: '北京电信', at: now - 12 * 60_000, values: [12] },
    { name: '北京联通', at: now - 5 * 60_000, values: [12] },
    { name: '上海电信', at: now - 20 * 60_000, values: [12] },
  ])
  const scope = effectScope()
  try {
    for (const [filter, minutes] of [['北京', 12], ['', 20]] as const) {
      const result = scope.run(() => useNodeCarrierPingStats('freshness-age', { hours: 1, taskNameFilter: filter }))!
      expect(result.lastFetchedAt.value).toBe(now - minutes * 60_000)
      expect(result.freshnessAgeMs.value).toBe(minutes * 60_000)
      expect(result.delayed.value).toBeTrue()
      expect(formatPingFreshnessAge(result.lastFetchedAt.value, now, 'zh-CN')).toBe(`${minutes} 分钟前`)
    }
    const disabled = scope.run(() => useNodeCarrierPingStats('freshness-age', { hours: 1, enabled: false }))!
    expect(disabled.lastFetchedAt.value).toBe(0)
    expect(disabled.freshnessAgeMs.value).toBe(0)
    const empty = scope.run(() => useNodeCarrierPingStats('freshness-age', { hours: 1, taskNameFilter: '广东' }))!
    expect(empty.freshnessAgeMs.value).toBe(0)
  }
  finally {
    scope.stop()
  }
})

test('P99/P50 remains a dimensionless ratio, with no millisecond jitter label', () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  const now = Date.now()
  pingFreshnessTick.value = now
  const pinia = createPinia()
  setActivePinia(pinia)
  const scope = effectScope()
  try {
    const displays = [[100, 100, 100], [100, 100, 200], [1000, 1000, 2000]].map((values, index) => {
      const uuid = `ratio-${index}`
      seed(uuid, [{ name: '北京电信', at: now, values }])
      return scope.run(() => useNodeCarrierPingDisplay(uuid))!.carrierDisplays.value.find(value => value.key === 'telecom')!
    })
    expect(displays[0]!.volatilityDisplay).toBe('1.00×')
    expect(displays[0]!.lossTooltip).toContain('波动 P99/P50 1.00×')
    expect(displays[0]!.lossTooltip).not.toContain('抖动')
    expect(displays[1]!.volatilityDisplay).toBe('1.98×')
    expect(displays[2]!.volatilityDisplay).toBe('1.98×')
  }
  finally {
    scope.stop()
    disposePinia(pinia)
  }
})
