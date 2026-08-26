import type { AdminPingTask } from '../../src/services/ping-task.model'
import { describe, expect, test } from 'bun:test'
import {
  assessCarrierProbeCandidate,
  buildCarrierProbeCandidate,
  classifyCarrierProbeHealth,
  migrateCarrierProbeTask,
  selectCarrierProbeTask,
  staleTransitCanaryTaskIds,
  validateCarrierProbeCandidate,
} from '../../src/services/carrier-probe.service'
import { getTopologyProbe } from '../../src/utils/topologyPresets'

const CLIENTS = Array.from({ length: 5 }, (_, index) => `node-${index + 1}`)

function task(overrides: Partial<AdminPingTask> = {}): AdminPingTask {
  return {
    id: 10,
    name: '北京移动',
    clients: CLIENTS,
    default_on: false,
    type: 'icmp',
    target: '221.179.155.161',
    interval: 30,
    ...overrides,
  }
}

describe('carrier probe health and migration', () => {
  test('区分四种目标健康状态并复用 5 台同步失败门槛', () => {
    expect(classifyCarrierProbeHealth({ onlineNodes: 0, observations: [], commonModeEvents: 0 })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 2,
      observations: [{ uuid: 'a', total: 3, valid: 3 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('healthy')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 1,
      observations: [{ uuid: 'a', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 3,
      observations: [{ uuid: 'a', total: 3, valid: 3 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 2,
      observations: [{ uuid: 'a', total: 3, valid: 0 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('single-path-anomaly')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 5,
      observations: CLIENTS.map(uuid => ({ uuid, total: 3, valid: 0 })),
      commonModeEvents: 1,
    })).toBe('shared-target-anomaly')
  })

  test('候选门槛支持多节点 95% 和单节点连续五次的低置信度', () => {
    expect(assessCarrierProbeCandidate([{ uuid: 'a', total: 5, valid: 5 }])).toMatchObject({ migratable: true, lowConfidence: true, successRate: 1 })
    expect(assessCarrierProbeCandidate([
      { uuid: 'a', total: 20, valid: 19 },
      { uuid: 'b', total: 20, valid: 19 },
    ])).toMatchObject({ migratable: true, lowConfidence: false, successRate: 0.95 })
    expect(assessCarrierProbeCandidate([
      { uuid: 'a', total: 20, valid: 20 },
      { uuid: 'b', total: 3, valid: 0 },
    ])).toMatchObject({ migratable: false })
    expect(buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')?.target).toBe('221.130.33.52:53')
    expect(buildCarrierProbeCandidate('icmp', '240e::1', undefined, 'custom')).toBeNull()
  })

  test('同类同名任务优先有成功样本，其次使用更新 ID', () => {
    const old = task({ id: 10 })
    const newest = task({ id: 11 })
    const unrelatedEntry = task({ id: 99, name: 'Transit-entry-beijing-mobile-icmp' })
    expect(selectCarrierProbeTask([old, newest, unrelatedEntry], getTopologyProbe('beijing-mobile'))?.id).toBe(11)
    expect(selectCarrierProbeTask([old, newest], getTopologyProbe('beijing-mobile'), new Map([
      [10, [{ uuid: 'a', total: 3, valid: 1 }]],
      [11, [{ uuid: 'a', total: 3, valid: 0 }]],
    ]))?.id).toBe(10)
    expect(selectCarrierProbeTask([old, newest], getTopologyProbe('beijing-mobile'), new Map([
      [10, []],
      [11, [{ uuid: 'a', total: 3, valid: 0 }]],
    ]))?.id).toBe(11)
  })

  test('只清理可识别且超过 30 分钟的 Transit canary', () => {
    const now = Date.UTC(2026, 7, 26, 12)
    expect(staleTransitCanaryTaskIds([
      task({ id: 1, name: `Transit-canary-beijing-mobile-${now - 31 * 60_000}` }),
      task({ id: 2, name: `Transit-canary-beijing-mobile-${now - 29 * 60_000}` }),
      task({ id: 3, name: `Other-canary-beijing-mobile-${now - 60 * 60_000}` }),
      task({ id: 4, name: `Transit-canary-unknown-${now - 60 * 60_000}` }),
    ], now)).toEqual([1])
  })

  test('验证备用目标创建临时任务并取得每台三次样本', async () => {
    let now = 1_777_000_000_000
    const created: AdminPingTask[] = []
    const candidate = buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')!
    const result = await validateCarrierProbeCandidate('beijing-mobile', task(), candidate, CLIENTS, {
      authorize: async () => {},
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      createTask: async (mutation: any) => {
        const value = task({ ...mutation, id: 20 })
        created.push(value)
        return value
      },
      deleteTasks: async () => true,
      loadSamples: async () => CLIENTS.map(uuid => ({ uuid, total: 3, valid: 3 })),
    })
    expect(created[0]).toMatchObject({ id: 20, interval: 30, clients: CLIENTS })
    expect(result).toMatchObject({ migratable: true, canaryTaskId: 20, successRate: 1 })
  })

  test('迁移等待首个成功样本后删除旧任务，失败则只清本轮资源', async () => {
    let now = 1_777_000_000_000
    const deleted: number[][] = []
    const replacement = task({ id: 30, target: '221.130.33.52:53', type: 'tcp' })
    const candidate = { ...buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')!, migratable: true, canaryTaskId: 20 }
    const success = await migrateCarrierProbeTask(task(), candidate, {
      authorize: async () => {},
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      createTask: async () => replacement,
      deleteTasks: async (ids: readonly number[]) => {
        deleted.push([...ids])
        return true
      },
      loadTasks: async () => [],
      loadSamples: async () => [{ uuid: CLIENTS[0]!, total: 1, valid: 1 }],
    })
    expect(success).toMatchObject({ ok: true, oldTaskId: 10, newTaskId: 30 })
    expect(deleted).toEqual([[10, 20]])

    deleted.length = 0
    now = 1_777_000_000_000
    const failed = await migrateCarrierProbeTask(task(), candidate, {
      authorize: async () => {},
      now: () => now,
      sleep: async () => { now += 5 * 60_000 },
      createTask: async () => replacement,
      deleteTasks: async (ids: readonly number[]) => {
        deleted.push([...ids])
        return deleted.length > 1
      },
      loadTasks: async () => [task(), replacement],
      loadSamples: async () => CLIENTS.map(uuid => ({ uuid, total: 5, valid: 0 })),
    })
    expect(failed.ok).toBeFalse()
    expect(failed.message).toContain('旧任务已保留')
    expect(deleted).toEqual([[30], [20]])
  })

  test('删除响应丢失但回查确认旧任务已删除时不误删新任务', async () => {
    const deleted: number[][] = []
    const replacement = task({ id: 30, target: '221.130.33.52:53', type: 'tcp' })
    const candidate = { ...buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')!, migratable: true, canaryTaskId: 20 }
    const result = await migrateCarrierProbeTask(task(), candidate, {
      authorize: async () => {},
      now: () => 1_777_000_000_000,
      sleep: async () => {},
      createTask: async () => replacement,
      deleteTasks: async (ids: readonly number[]) => {
        deleted.push([...ids])
        return false
      },
      loadTasks: async () => [replacement],
      loadSamples: async () => [{ uuid: CLIENTS[0]!, total: 1, valid: 1 }],
    })
    expect(result).toMatchObject({ ok: true, newTaskId: 30 })
    expect(deleted).toEqual([[10, 20]])
  })

  test('旧任务仍存在时才补偿删除本轮创建的新任务', async () => {
    const deleted: number[][] = []
    const replacement = task({ id: 30, target: '221.130.33.52:53', type: 'tcp' })
    const candidate = { ...buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')!, migratable: true, canaryTaskId: 20 }
    const result = await migrateCarrierProbeTask(task(), candidate, {
      authorize: async () => {},
      now: () => 1_777_000_000_000,
      sleep: async () => {},
      createTask: async () => replacement,
      deleteTasks: async (ids: readonly number[]) => {
        deleted.push([...ids])
        return deleted.length > 1
      },
      loadTasks: async () => [task(), replacement],
      loadSamples: async () => [{ uuid: CLIENTS[0]!, total: 1, valid: 1 }],
    })
    expect(result.ok).toBeFalse()
    expect(result.message).toContain('旧任务已保留')
    expect(deleted).toEqual([[10, 20], [30], [20]])
  })
})
