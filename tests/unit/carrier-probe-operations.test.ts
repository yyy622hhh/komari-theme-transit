import type { CarrierOperationRecord } from '../../src/services/carrier-probe-operation.service'
import type { CarrierProbeOperations } from '../../src/services/carrier-probe.service'
import type { AdminPingTask } from '../../src/services/ping-task.model'
import { describe, expect, test } from 'bun:test'
import { carrierTaskSnapshot, reconcileCarrierOperation, selectCarrierOperationIdsToRetain, withCarrierOperationLock } from '../../src/services/carrier-probe-operation.service'
import { buildCarrierProbeCandidate, currentCarrierProbeCandidate, migrateCarrierProbeTask, validateCarrierProbeCandidate } from '../../src/services/carrier-probe.service'

function harness() {
  let now = Date.now() - 600_000
  const original: AdminPingTask = { id: 10, name: '北京移动', type: 'icmp', target: '192.0.2.1', clients: ['a', 'b'], interval: 30, default_on: true }
  const live = new Map([[10, original]])
  const deleted: number[] = []
  let nextId = 20
  const ops: CarrierProbeOperations = {
    authorize: async () => {},
    now: () => now,
    sleep: async (ms) => { now += ms },
    withLock: async (_id, _mutation, run) => run(),
    loadTasks: async () => [...live.values()],
    createTask: async (input) => {
      const task = { ...input, id: nextId++ }
      live.set(task.id, task)
      return task
    },
    deleteTasks: async (ids) => {
      ids.forEach((id) => {
        deleted.push(id)
        live.delete(id)
      })
      return true
    },
    loadSamples: async (id, clients, since = now) => {
      now += 90_000
      return clients.map((uuid) => {
        const records = [0, 1, 2].map(i => ({ client: uuid, task_id: id, value: 12, time: new Date(Math.max(since, now - 60_000) + i * 30_000).toISOString() }))
        return { uuid, records, total: 3, valid: 3 }
      })
    },
  }
  const validate = () => validateCarrierProbeCandidate('beijing-mobile', original, buildCarrierProbeCandidate('tcp', '192.0.2.2', 53, 'builtin')!, original.clients, ops)
  return { original, live, deleted, ops, validate, advance: (ms: number) => {
    now += ms
  } }
}

describe('carrier operation safety', () => {
  test('journal retention caps completed records without dropping recovery evidence', () => {
    const task: AdminPingTask = { id: 10, name: '北京移动', type: 'icmp', target: '192.0.2.1', clients: ['a'], interval: 30, default_on: true }
    const records: CarrierOperationRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `done-${index}`,
      key: 'beijing-mobile',
      kind: 'verify' as const,
      original: task,
      created: [],
      phase: 'done' as const,
      startedAt: index,
      updatedAt: index,
      message: 'done',
    }))
    records.push(
      { ...records[0]!, id: 'needs-created-cleanup', phase: 'failed', created: [{ ...task, id: 11 }] },
      { ...records[0]!, id: 'uncertain-creation', phase: 'failed', uncertainCreation: true },
    )

    const retained = selectCarrierOperationIdsToRetain(records)
    expect(retained).toHaveLength(22)
    expect(retained.has('done-29')).toBe(true)
    expect(retained.has('done-10')).toBe(true)
    expect(retained.has('done-9')).toBe(false)
    expect(retained.has('needs-created-cleanup')).toBe(true)
    expect(retained.has('uncertain-creation')).toBe(true)
  })

  test('replacement preserves offline assignments but confirms success using online sources', async () => {
    const h = harness()
    h.original.clients.push('offline')
    h.ops.isOnline = client => client !== 'offline'
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result.ok).toBeTrue()
    expect(h.live.get(20)?.clients).toEqual(['a', 'b', 'offline'])
  })
  test('permission loss during sampling leaves old task and reports uncleared resources', async () => {
    const h = harness()
    const load = h.ops.loadSamples
    h.ops.loadSamples = async (...args) => {
      const samples = await load(...args)
      h.ops.authorize = async () => {
        throw new Error('expired')
      }
      return samples
    }
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result).toMatchObject({ ok: false, remainingTaskIds: [20] })
    expect(h.deleted).toEqual([])
    expect(result.message).not.toContain('完成回滚')
  })
  test('journal failure after creation does not bypass compensation', async () => {
    const h = harness()
    h.ops.progress = (phase) => {
      if (phase === 'sampling' || phase === 'cleanup')
        throw new Error('local storage unavailable')
    }
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result.ok).toBeFalse()
    expect(h.deleted).toEqual([20])
  })
  test('single-node validation waits for a new five-success streak after failure', async () => {
    const h = harness()
    h.original.clients = ['a']
    const started = h.ops.now()
    let calls = 0
    h.ops.loadSamples = async (id) => {
      calls++
      const values = calls === 1 ? [1, 1, 1, 1, -1] : [1, 1, 1, 1, -1, 1, 1, 1, 1, 1]
      h.advance(30_000)
      return [{ uuid: 'a', total: 20, valid: 19, records: values.map((value, index) => ({ task_id: id, client: 'a', value, time: new Date(started + index * 1000).toISOString() })) }]
    }
    const candidate = await h.validate()
    expect(calls).toBe(2)
    expect(candidate).toMatchObject({ migratable: true, lowConfidence: true })
  })
  test('incomplete raw samples time out and canary cleanup failure is explicit', async () => {
    const h = harness()
    h.ops.loadSamples = async () => []
    h.ops.deleteTasks = async () => false
    await expect(h.validate()).rejects.toThrow('等待 4 分钟超时')
    expect(h.live.has(20)).toBeTrue()
  })
  test('same-task concurrent operation is rejected and exceptions always release the local lock', async () => {
    let release!: () => void
    const pending = withCarrierOperationLock(101, false, () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await expect(withCarrierOperationLock(101, false, async () => {})).rejects.toThrow('已有操作')
    release()
    await pending
    await expect(withCarrierOperationLock(101, false, async () => {
      throw new Error('expired')
    })).rejects.toThrow('expired')
    expect(await withCarrierOperationLock(101, false, async () => 'unlocked')).toBe('unlocked')
  })
  test('validation binds exact snapshots and migration rechecks raw evidence', async () => {
    const h = harness()
    const candidate = await h.validate()
    expect(candidate).toMatchObject({ migratable: true, canaryTaskId: 20, originalSnapshot: carrierTaskSnapshot(h.original) })
    const result = await migrateCarrierProbeTask(h.original, candidate, h.ops)
    expect(result).toMatchObject({ ok: true, oldTaskId: 10, newTaskId: 21 })
    expect(h.deleted).toEqual([10, 20])
    expect(h.live.get(21)).toMatchObject({ default_on: true, clients: ['a', 'b'], interval: 30 })
  })
  test('refuses expired, changed, or aggregate-only evidence without creating replacement', async () => {
    for (const scenario of ['expired', 'changed', 'aggregate']) {
      const h = harness()
      const candidate = await h.validate()
      if (scenario === 'expired')
        h.advance(1_800_000)
      if (scenario === 'changed')
        h.live.set(10, { ...h.original, target: '192.0.2.99' })
      if (scenario === 'aggregate')
        h.ops.loadSamples = async (_id, clients) => clients.map(uuid => ({ uuid, total: 20, valid: 20 }))
      expect((await migrateCarrierProbeTask(h.original, candidate, h.ops)).ok).toBeFalse()
      expect(h.live.has(10)).toBeTrue()
      expect(h.live.has(21)).toBeFalse()
    }
  })
  test('lost delete response reconciles before compensating', async () => {
    const h = harness()
    const candidate = await h.validate()
    const remove = h.ops.deleteTasks
    h.ops.deleteTasks = async (ids) => {
      await remove(ids)
      return false
    }
    expect((await migrateCarrierProbeTask(h.original, candidate, h.ops)).ok).toBeTrue()
    expect(h.live.has(21)).toBeTrue()
    expect(h.deleted).toEqual([10, 20])
  })
  test('failed cleanup retains replacement if old deletion cannot be confirmed', async () => {
    const h = harness()
    const candidate = await h.validate()
    const list = h.ops.loadTasks!
    let deleted = false
    h.ops.deleteTasks = async () => {
      deleted = true
      return false
    }
    h.ops.loadTasks = async () => {
      if (deleted)
        throw new Error('network')
      return list()
    }
    const result = await migrateCarrierProbeTask(h.original, candidate, h.ops)
    expect(result.ok).toBeFalse()
    expect(result.remainingTaskIds).toContain(21)
    expect(h.live.has(21)).toBeTrue()
    expect(result.message).toContain('未确认')
  })
  test('original changes while sampling: no old-task deletion, compensate only unchanged new resource', async () => {
    const h = harness()
    const load = h.ops.loadSamples
    h.ops.loadSamples = async (...args) => {
      const result = await load(...args)
      h.live.set(10, { ...h.original, interval: 60 })
      return result
    }
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result.ok).toBeFalse()
    expect(h.deleted).toEqual([20])
    expect(h.live.has(10)).toBeTrue()
  })
  for (const mode of ['rebuild', 'migrate'] as const) {
    for (const change of ['name', 'type', 'target', 'clients', 'interval', 'default_on', 'deleted'] as const) {
      test(`${mode} keeps the original when replacement ${change} changes during sampling`, async () => {
        const h = harness()
        const candidate = mode === 'migrate' ? await h.validate() : currentCarrierProbeCandidate(h.original)!
        const load = h.ops.loadSamples
        const replacementId = mode === 'migrate' ? 21 : 20
        h.ops.loadSamples = async (...args) => {
          const samples = await load(...args)
          if (args[0] === replacementId) {
            const replacement = h.live.get(replacementId)!
            if (change === 'deleted') {
              h.live.delete(replacementId)
            }
            else {
              const changes = { name: '管理员新名称', type: 'http', target: '192.0.2.99', clients: ['a'], interval: 60, default_on: false }
              h.live.set(replacementId, { ...replacement, [change]: changes[change] })
            }
          }
          return samples
        }
        const result = await migrateCarrierProbeTask(h.original, candidate, h.ops)
        expect(result.ok).toBeFalse()
        expect(result.message).toContain('替代任务已被删除或修改')
        expect(h.live.get(10)).toEqual(h.original)
        expect(h.deleted).toEqual(mode === 'migrate' ? [20] : [])
        expect(result.remainingTaskIds).toEqual(change === 'deleted' ? [] : [replacementId])
      })
    }
  }
  test('the final deletion guard rechecks replacement after entering the deleting phase', async () => {
    const h = harness()
    h.ops.progress = (phase) => {
      if (phase === 'deleting')
        h.live.delete(20)
    }
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result.ok).toBeFalse()
    expect(result.message).toContain('替代任务已被删除或修改')
    expect(h.live.has(10)).toBeTrue()
    expect(h.deleted).toEqual([])
  })
  test('authentication rejection is reported and never becomes an unhandled rejection', async () => {
    const h = harness()
    h.ops.authorize = async () => {
      throw new Error('登录状态已过期')
    }
    const result = await migrateCarrierProbeTask(h.original, currentCarrierProbeCandidate(h.original)!, h.ops)
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('登录状态已过期')
    expect(h.deleted).toEqual([])
  })
  test('reload reconciliation is read-only and missing Web Locks rejects mutation', async () => {
    const h = harness()
    const record: any = { original: h.original, created: [], phase: 'creating' }
    expect(reconcileCarrierOperation(record, [h.original]).message).toContain('未执行任何变更')
    expect(h.deleted).toEqual([])
    await expect(withCarrierOperationLock(10, true, async () => 1)).rejects.toThrow('Web Locks')
  })
})
