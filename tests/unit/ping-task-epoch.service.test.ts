import type { PingTaskInfo } from '../../src/utils/rpcTypes'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  filterMetricLossToCurrentEpoch,
  filterPingRecordsToCurrentEpoch,
  observePingTaskEpochs,
  pingTaskEpochStartedAt,
  resetPingTaskEpochCache,
} from '../../src/services/ping-task-epoch.service'

const originalLocalStorage = globalThis.localStorage
let values = new Map<string, string>()

function installLocalStorage(): void {
  values = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  })
}

function task(target?: string, type = 'icmp'): PingTaskInfo {
  return {
    id: 7,
    name: '北京联通',
    interval: 30,
    loss: 0,
    type,
    ...(target ? { target } : {}),
  }
}

beforeEach(() => {
  installLocalStorage()
  resetPingTaskEpochCache()
})
afterAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
  resetPingTaskEpochCache()
})

describe('Ping task measurement epochs', () => {
  test('the first target observation establishes a baseline without deleting legitimate history', () => {
    expect(observePingTaskEpochs([task('202.106.195.68')], 'admin', 1_000)).toEqual([])
    expect(pingTaskEpochStartedAt(7)).toBe(0)
    expect(localStorage.getItem('transit:ping-task-epochs:v2')).not.toContain('202.106.195.68')
  })

  test('an observed in-place target edit starts a new epoch and excludes older records', () => {
    observePingTaskEpochs([task('202.106.195.68')], 'admin', 1_000)
    expect(observePingTaskEpochs([task('202.106.50.1')], 'admin', 2_000)).toEqual([7])
    expect(pingTaskEpochStartedAt(7)).toBe(2_000)

    const records = filterPingRecordsToCurrentEpoch([
      { client: 'node', task_id: 7, time: new Date(1_999).toISOString(), value: -1 },
      { client: 'node', task_id: 7, time: new Date(2_000).toISOString(), value: 48 },
    ])
    expect(records.map(record => record.value)).toEqual([48])
    expect(filterMetricLossToCurrentEpoch([
      { taskId: 7, time: new Date(1_999).toISOString(), value: 1, count: 3 },
      { taskId: 7, time: new Date(2_000).toISOString(), value: 0, count: 3 },
    ])).toHaveLength(1)
  })

  test('a public catalogue without targets cannot invent a target change', () => {
    observePingTaskEpochs([task()], 'admin', 1_000)
    observePingTaskEpochs([task('202.106.195.68')], 'admin', 2_000)
    expect(pingTaskEpochStartedAt(7)).toBe(0)

    observePingTaskEpochs([task()], 'admin', 3_000)
    expect(pingTaskEpochStartedAt(7)).toBe(0)
    expect(observePingTaskEpochs([task('202.106.50.1')], 'admin', 4_000)).toEqual([7])
    expect(pingTaskEpochStartedAt(7)).toBe(4_000)
  })

  test('a protocol change is visible in the public catalogue and also resets the epoch', () => {
    observePingTaskEpochs([task(undefined, 'icmp')], 'admin', 1_000)
    expect(observePingTaskEpochs([task(undefined, 'tcp')], 'admin', 2_000)).toEqual([7])
    expect(pingTaskEpochStartedAt(7)).toBe(2_000)
  })

  test('the epoch boundary survives a reload and damaged storage fails open', () => {
    observePingTaskEpochs([task('202.106.195.68')], 'admin', 1_000)
    observePingTaskEpochs([task('202.106.50.1')], 'admin', 2_000)
    resetPingTaskEpochCache()
    expect(pingTaskEpochStartedAt(7)).toBe(2_000)

    localStorage.setItem('transit:ping-task-epochs:v2', 'not-json')
    resetPingTaskEpochCache()
    expect(pingTaskEpochStartedAt(7)).toBe(0)
  })

  test('public and admin catalogues never compare fingerprints against each other', () => {
    // 公开目录先带上目标（假设某天它开始带），管理员目录随后用不同格式描述
    // 同一个目标（比如带没带端口号）。两边各自建立自己的基线，互相不比较，
    // 不该只因为格式不同就判成「目标变了」。
    observePingTaskEpochs([task('202.106.195.68')], 'public', 1_000)
    expect(observePingTaskEpochs([task('202.106.195.68:0')], 'admin', 2_000)).toEqual([])
    expect(pingTaskEpochStartedAt(7)).toBe(0)

    // 之后公开目录自己观测到目标变化，仍然只按公开目录自己的基线判定。
    expect(observePingTaskEpochs([task('202.106.50.1')], 'public', 3_000)).toEqual([7])
    expect(pingTaskEpochStartedAt(7)).toBe(3_000)

    // 管理员目录这时候还是老格式的同一个目标，不该被公开目录刚才的重置带崩。
    expect(observePingTaskEpochs([task('202.106.195.68:0')], 'admin', 4_000)).toEqual([])
  })

  test('a probe type longer than the storage schema allows is truncated at write time, not silently dropped on reload', () => {
    const longType = 'a'.repeat(64)
    observePingTaskEpochs([task(undefined, longType)], 'admin', 1_000)
    resetPingTaskEpochCache()
    // 重新加载后仍然认得这条记录（没有因为长度校验被整条丢弃），且类型变化
    // 判断用的是同一个截断后的值，不会把「没变」误判成「变了」。
    expect(observePingTaskEpochs([task(undefined, longType)], 'admin', 2_000)).toEqual([])
  })

  test('bounds both the live catalogue and its persisted copy', () => {
    const first = Array.from({ length: 300 }, (_, index) => ({ ...task('192.0.2.1'), id: index + 1 }))
    const changed = first.map(value => ({ ...value, target: '192.0.2.2' }))
    observePingTaskEpochs(first, 'admin', 1_000)
    observePingTaskEpochs(changed, 'admin', 2_000)

    const persisted = JSON.parse(localStorage.getItem('transit:ping-task-epochs:v2') ?? '[]') as unknown[]
    expect(persisted).toHaveLength(256)
    expect(pingTaskEpochStartedAt(300)).toBe(2_000)
    // ID 1 was evicted from memory as well. Seeing it again establishes a
    // baseline instead of using the stale pre-eviction fingerprint.
    expect(observePingTaskEpochs([{ ...task('192.0.2.3'), id: 1 }], 'admin', 3_000)).toEqual([])
    expect(pingTaskEpochStartedAt(1)).toBe(0)
  })
})
