import type { AdminPingTask } from '../../src/services/ping-task.service'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { invalidateAdminPingTasksCache } from '../../src/services/ping-task.service'
import {
  assessHopTask,
  chooseInitialHopProbe,
  loadSourceProbeProfile,
  planEntryProbeTask,
  planWorkingHopTask,
} from '../../src/services/topology-probe.service'
import { resetSharedRpc } from '../../src/utils/rpc'
import { createCustomTopologyProbe, getTopologyProbe } from '../../src/utils/topologyPresets'

const source = { uuid: 'relay-uuid', name: 'Relay-JP', ipv4: '192.0.2.10' }
const landing = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20' }

interface StatFixture {
  entity_id?: string
  task_id: string
  name?: string
  total: number
  valid: number
}

interface LegacyRecordFixture {
  client: string
  task_id: number
  time: string
  value: number
}

function mockKomari(
  tasks: AdminPingTask[],
  stats: StatFixture[],
  options: { metricStatsUnsupported?: boolean, legacyRecords?: LegacyRecordFixture[] } = {},
): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body)
      return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
    const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
    if (request.method === 'admin:getAllPingTasks')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
    if (request.method === 'public:getPingMetricStats') {
      if (options.metricStatsUnsupported) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'method not found' },
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          count: stats.length,
          stats: stats.map(stat => ({
            entity_id: stat.entity_id ?? source.uuid,
            task_id: stat.task_id,
            name: stat.name,
            total: stat.total,
            valid: stat.valid,
            loss: stat.valid > 0 ? 0 : 100,
            loss_approximate: false,
          })),
        },
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (request.method === 'common:getRecords') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { records: options.legacyRecords ?? [], tasks: [] },
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (request.method === 'admin:addPingTask') {
      tasks.push({ ...request.params!, id: 900 + tasks.length })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`Unexpected RPC method: ${request.method}`)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

afterEach(() => {
  mock.restore()
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  // 短 TTL 缓存跨测试用例存活；每个用例都要用自己的 mockKomari 夹具，不能读到
  // 上一个用例缓存下来的任务列表。
  invalidateAdminPingTasksCache()
})

describe('topology hop probe selection', () => {
  test('prefers ICMP when the relay already has a healthy ICMP task', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'icmp-ok', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
        { id: 2, name: 'tcp-ok', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 },
      ],
      [
        { task_id: '1', name: 'icmp-ok', total: 100, valid: 100 },
        { task_id: '2', name: 'tcp-ok', total: 100, valid: 100 },
      ],
    )
    try {
      expect(chooseInitialHopProbe(await loadSourceProbeProfile(source.uuid))).toEqual({ type: 'icmp' })
    }
    finally {
      restore()
    }
  })

  test('breaks a TCP port tie by the probe ladder order', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'https', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 },
        { id: 2, name: 'http', clients: [source.uuid], type: 'tcp', target: '198.51.100.3:80', interval: 30 },
      ],
      [
        { task_id: '1', name: 'https', total: 100, valid: 99 },
        { task_id: '2', name: 'http', total: 100, valid: 99 },
      ],
    )
    try {
      expect(chooseInitialHopProbe(await loadSourceProbeProfile(source.uuid))).toEqual({ type: 'tcp', port: 443 })
    }
    finally {
      restore()
    }
  })

  test('falls back to the most common healthy TCP port when ICMP produces nothing', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'icmp-dead', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
        { id: 2, name: 'telecom', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:80', interval: 30 },
        { id: 3, name: 'unicom', clients: [source.uuid], type: 'tcp', target: '198.51.100.3:80', interval: 30 },
        { id: 4, name: 'mobile', clients: [source.uuid], type: 'tcp', target: '198.51.100.4:443', interval: 30 },
        { id: 5, name: 'other-relay', clients: ['someone-else'], type: 'tcp', target: '198.51.100.5:8080', interval: 30 },
      ],
      [
        { task_id: '1', name: 'icmp-dead', total: 100, valid: 0 },
        { task_id: '2', name: 'telecom', total: 100, valid: 99 },
        { task_id: '3', name: 'unicom', total: 100, valid: 98 },
        { task_id: '4', name: 'mobile', total: 100, valid: 97 },
        { task_id: '5', name: 'other-relay', total: 100, valid: 100 },
      ],
    )
    try {
      expect(chooseInitialHopProbe(await loadSourceProbeProfile(source.uuid))).toEqual({ type: 'tcp', port: 80 })
    }
    finally {
      restore()
    }
  })

  test('keeps ICMP when nothing on the relay is producing samples', async () => {
    const restore = mockKomari(
      [{ id: 1, name: 'tcp-dead', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 }],
      [{ task_id: '1', name: 'tcp-dead', total: 10, valid: 0 }],
    )
    try {
      expect(chooseInitialHopProbe(await loadSourceProbeProfile(source.uuid))).toEqual({ type: 'icmp' })
    }
    finally {
      restore()
    }
  })

  test('only calls a probe dead once it has collected enough failed samples', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'fresh', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
        { id: 2, name: 'few-failures', clients: [source.uuid], type: 'icmp', target: '198.51.100.2', interval: 30 },
        { id: 3, name: 'dead', clients: [source.uuid], type: 'icmp', target: '198.51.100.3', interval: 30 },
        { id: 4, name: 'healthy', clients: [source.uuid], type: 'icmp', target: '198.51.100.4', interval: 30 },
        { id: 5, name: 'unknown', clients: [source.uuid], type: 'icmp', target: '198.51.100.5', interval: 30 },
      ],
      [
        { task_id: '1', name: 'fresh', total: 0, valid: 0 },
        { task_id: '2', name: 'few-failures', total: 2, valid: 0 },
        { task_id: '3', name: 'dead', total: 3, valid: 0 },
        { task_id: '4', name: 'healthy', total: 3, valid: 1 },
      ],
    )
    try {
      const profile = await loadSourceProbeProfile(source.uuid)
      expect(assessHopTask(profile, { id: 1, name: 'fresh' })).toBe('pending')
      expect(assessHopTask(profile, { id: 2, name: 'few-failures' })).toBe('pending')
      expect(assessHopTask(profile, { id: 3, name: 'dead' })).toBe('dead')
      expect(assessHopTask(profile, { id: 4, name: 'healthy' })).toBe('healthy')
      expect(assessHopTask(profile, { id: 5, name: 'unknown' })).toBe('pending')
    }
    finally {
      restore()
    }
  })
})

describe('planWorkingHopTask cache freshness', () => {
  test('options.fresh bypasses the admin task list cache', async () => {
    const tasks: AdminPingTask[] = [
      { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4!, interval: 30 },
    ]
    const originalFetch = globalThis.fetch
    let listCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks') {
        listCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'public:getPingMetricStats') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { count: 0, stats: [] } }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(listCalls).toBe(1)

      // A plain re-plan right after should be served from cache.
      await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(listCalls).toBe(1)

      // The in-lock re-check (topology-repair.service.ts) asks for a fresh
      // read specifically so it can observe another tab's concurrent write.
      await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG', { fresh: true })
      expect(listCalls).toBe(2)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('topology hop task planning', () => {
  test('plans a TCP hop task when the relay cannot use ICMP', async () => {
    const restore = mockKomari(
      [{ id: 1, name: 'telecom', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 }],
      [{ task_id: '1', name: 'telecom', total: 100, valid: 100 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing)
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toBeNull()
      expect(planned.task).toMatchObject({
        name: 'Transit-Relay-JP-to-Exit-SG-tcp-443',
        type: 'tcp',
        target: '203.0.113.20:443',
        clients: [source.uuid],
      })
    }
    finally {
      restore()
    }
  })

  test('escalates to the next probe once the bound task is proven dead', async () => {
    const restore = mockKomari(
      [{ id: 7, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 }],
      [{ task_id: '7', name: 'Transit-Relay-JP-to-Exit-SG', total: 40, valid: 0 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(planned.switchedFrom).toEqual({ type: 'icmp' })
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.task.name).toBe('Transit-Relay-JP-to-Exit-SG-tcp-443')
      expect(planned.exhausted).toBe(false)
    }
    finally {
      restore()
    }
  })

  test('uses legacy Ping records when metric statistics are unavailable', async () => {
    const taskName = 'Transit-Relay-JP-to-Exit-SG'
    const restore = mockKomari(
      [{ id: 7, name: taskName, clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 }],
      [],
      {
        metricStatsUnsupported: true,
        legacyRecords: [1, 2, 3].map(index => ({
          client: source.uuid,
          task_id: 7,
          time: `2026-08-18T00:0${index}:00.000Z`,
          value: -1,
        })),
      },
    )
    try {
      const planned = await planWorkingHopTask(source, landing, taskName)
      expect(planned.switchedFrom).toEqual({ type: 'icmp' })
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.verdict).toBe('pending')
      expect(planned.needsCreation).toBe(true)
    }
    finally {
      restore()
    }
  })

  test('keeps a healthy bound task instead of re-deriving it from the address', async () => {
    const restore = mockKomari(
      [
        { id: 7, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 8, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
      ],
      [
        { task_id: '7', name: 'Transit-Relay-JP-to-Exit-SG', total: 40, valid: 0 },
        { task_id: '8', name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', total: 40, valid: 39 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-443')
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.verdict).toBe('healthy')
      expect(planned.needsCreation).toBe(false)
      expect(planned.switchedFrom).toBeNull()
    }
    finally {
      restore()
    }
  })

  test('switches a dead binding to another healthy task for the same source and landing', async () => {
    const restore = mockKomari(
      [
        { id: 7, name: 'Transit-Relay-JP-to-Exit-SG-tcp-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
        { id: 8, name: 'working-custom-task', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:20002`, interval: 30 },
      ],
      [
        { task_id: '7', total: 40, valid: 0 },
        { task_id: '8', total: 40, valid: 40 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-80')
      expect(planned.task.name).toBe('working-custom-task')
      expect(planned.probe).toEqual({ type: 'tcp', port: 20002 })
      expect(planned.verdict).toBe('healthy')
      expect(planned.needsCreation).toBe(false)
      expect(planned.switchedFrom).toEqual({ type: 'tcp', port: 80 })
    }
    finally {
      restore()
    }
  })

  test('keeps the exact healthy task when two landing tasks use the same probe', async () => {
    const restore = mockKomari(
      [
        { id: 7, weight: 1, name: 'dead-port-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
        { id: 8, weight: 2, name: 'healthy-port-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
      ],
      [
        { task_id: '7', total: 40, valid: 0 },
        { task_id: '8', total: 40, valid: 40 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'dead-port-80')
      expect(planned.task.name).toBe('healthy-port-80')
      expect(planned.probe).toEqual({ type: 'tcp', port: 80 })
      expect(planned.verdict).toBe('healthy')
      expect(planned.needsCreation).toBe(false)
    }
    finally {
      restore()
    }
  })

  test('tries a landing port proven healthy from another source before the fixed ladder', async () => {
    const otherSource = 'other-relay-uuid'
    const restore = mockKomari(
      [
        { id: 7, name: 'Transit-Relay-JP-to-Exit-SG-tcp-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
        { id: 18, name: 'known-working-landing-port', clients: [otherSource], type: 'tcp', target: `${landing.ipv4}:20002`, interval: 30 },
      ],
      [
        { entity_id: source.uuid, task_id: '7', total: 40, valid: 0 },
        { entity_id: otherSource, task_id: '18', total: 40, valid: 39 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-80')
      expect(planned.probe).toEqual({ type: 'tcp', port: 20002 })
      expect(planned.task).toMatchObject({
        name: 'Transit-Relay-JP-to-Exit-SG-tcp-20002',
        target: `${landing.ipv4}:20002`,
        clients: [source.uuid],
      })
      expect(planned.verdict).toBe('pending')
      expect(planned.needsCreation).toBe(true)
    }
    finally {
      restore()
    }
  })

  test('never uses another source samples to mark the current source healthy', async () => {
    const otherSource = 'other-relay-uuid'
    const restore = mockKomari(
      [{
        id: 18,
        name: 'shared-landing-port',
        clients: [source.uuid, otherSource],
        type: 'tcp',
        target: `${landing.ipv4}:20002`,
        interval: 30,
      }],
      [
        { entity_id: source.uuid, task_id: '18', total: 40, valid: 0 },
        { entity_id: otherSource, task_id: '18', total: 40, valid: 39 },
      ],
    )
    try {
      const profile = await loadSourceProbeProfile(source.uuid)
      expect(assessHopTask(profile, { id: 18, name: 'shared-landing-port' })).toBe('dead')

      const planned = await planWorkingHopTask(source, landing, 'shared-landing-port')
      expect(planned.probe).toEqual({ type: 'icmp' })
      expect(planned.verdict).toBe('pending')
      expect(planned.needsCreation).toBe(true)
    }
    finally {
      restore()
    }
  })

  test('reports exhaustion with the landing address once every probe is dead', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
        { id: 3, name: 'Transit-Relay-JP-to-Exit-SG-tcp-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
        { id: 4, name: 'Transit-Relay-JP-to-Exit-SG-tcp-22', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:22`, interval: 30 },
      ],
      [
        { task_id: '1', total: 40, valid: 0 },
        { task_id: '2', total: 40, valid: 0 },
        { task_id: '3', total: 40, valid: 0 },
        { task_id: '4', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(planned.exhausted).toBe(true)
      expect(planned.verdict).toBe('dead')
      expect(planned.targetAddress).toBe(landing.ipv4)
      expect(planned.needsCreation).toBe(false)
    }
    finally {
      restore()
    }
  })

  test('skips a dead rung and lands on the next usable one', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
      ],
      [
        { task_id: '1', total: 40, valid: 0 },
        { task_id: '2', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(planned.probe).toEqual({ type: 'tcp', port: 80 })
      expect(planned.task.name).toBe('Transit-Relay-JP-to-Exit-SG-tcp-80')
      expect(planned.needsCreation).toBe(true)
    }
    finally {
      restore()
    }
  })

  test('ignores a bound task that points at a different landing', async () => {
    const restore = mockKomari(
      [{ id: 9, name: 'stale-hop', clients: [source.uuid], type: 'icmp', target: '198.51.100.77', interval: 30 }],
      [{ task_id: '9', name: 'stale-hop', total: 40, valid: 40 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'stale-hop')
      expect(planned.needsCreation).toBe(true)
      expect(planned.task.name).toBe('Transit-Relay-JP-to-Exit-SG')
      expect(planned.task.target).toBe(landing.ipv4)
    }
    finally {
      restore()
    }
  })

  test('marks only dead convention-matching tasks as cleanup candidates', async () => {
    const restore = mockKomari(
      [
        { id: 7, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        // 自定义名称不会进入候选；调用方还会再核对本会话创建的任务 ID。
        { id: 8, name: 'ops-ssh-check', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:22`, interval: 30 },
      ],
      [
        { task_id: '7', name: 'Transit-Relay-JP-to-Exit-SG', total: 40, valid: 0 },
        { task_id: '8', name: 'ops-ssh-check', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([7])
    }
    finally {
      restore()
    }
  })

  test('keeps every rung on record once the ladder is exhausted', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
        { id: 3, name: 'Transit-Relay-JP-to-Exit-SG-tcp-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 },
        { id: 4, name: 'Transit-Relay-JP-to-Exit-SG-tcp-22', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:22`, interval: 30 },
      ],
      [1, 2, 3, 4].map(id => ({ task_id: String(id), total: 40, valid: 0 })),
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-22')
      expect(planned.exhausted).toBe(true)
      // 删掉就等于忘了「这一档试过」，下次复检会把它们全建回来。
      expect(planned.retiredTasks).toEqual([])
    }
    finally {
      restore()
    }
  })

  test('marks a dead convention-matching task once a later probe is healthy', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
      ],
      [
        { task_id: '1', total: 40, valid: 0 },
        { task_id: '2', total: 40, valid: 40 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-443')
      expect(planned.verdict).toBe('healthy')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([1])
    }
    finally {
      restore()
    }
  })

  test('rejects planning when the landing has no pingable address', async () => {
    await expect(planWorkingHopTask(source, { uuid: 'bad', name: 'No-IP' })).rejects.toThrow('没有可用于 Ping')
  })
})

describe('planEntryProbeTask', () => {
  const beijingTelecom = getTopologyProbe('beijing-telecom')
  const guangzhouTelecom = getTopologyProbe('guangzhou-telecom')

  test('keeps a custom task identity stable when only its display label changes', () => {
    const first = createCustomTopologyProbe('湖北电信', 'probe.example.com')!
    const renamed = createCustomTopologyProbe('武汉电信', 'probe.example.com')!
    const moved = createCustomTopologyProbe('武汉电信', 'other.example.com')!
    expect(renamed.key).toBe(first.key)
    expect(renamed.taskFilter).toBe(first.taskFilter)
    expect(moved.key).not.toBe(first.key)
  })

  test('retires the previous owned binding when a custom target changes', async () => {
    const previous = createCustomTopologyProbe('湖北电信', 'old.example.com')!
    const current = createCustomTopologyProbe('湖北电信', 'new.example.com')!
    const restore = mockKomari(
      [{ id: 54, name: previous.taskFilter, clients: [source.uuid], type: 'icmp', target: 'old.example.com', interval: 30 }],
      [{ task_id: '54', total: 40, valid: 40 }],
    )
    try {
      const planned = await planEntryProbeTask(source, current, { currentTaskName: previous.taskFilter })
      expect(planned.needsCreation).toBe(true)
      expect(planned.task.name).toBe(current.taskFilter)
      expect(planned.task.target).toBe('new.example.com')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([54])
    }
    finally {
      restore()
    }
  })

  test('does not reuse a same-label task for a custom target', async () => {
    const custom = createCustomTopologyProbe('湖北电信', 'probe.example.com')!
    const restore = mockKomari(
      [{ id: 55, name: '湖北电信', clients: [source.uuid], type: 'icmp', target: '198.51.100.55', interval: 30 }],
      [{ task_id: '55', total: 40, valid: 40 }],
    )
    try {
      const planned = await planEntryProbeTask(source, custom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.task.name).toBe(custom.taskFilter)
      expect(planned.task.target).toBe('probe.example.com')
    }
    finally {
      restore()
    }
  })

  test('creates a fresh ICMP task named after the taskFilter, targeting the landmark address, when nothing exists', async () => {
    const restore = mockKomari([], [])
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.probe).toEqual({ type: 'icmp' })
      expect(planned.retiredTasks).toEqual([])
      expect(planned.switchedFrom).toBeNull()
      expect(planned.task).toMatchObject({ name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [source.uuid] })
    }
    finally {
      restore()
    }
  })

  test('reuses an existing task matched by name regardless of its actual target', async () => {
    const restore = mockKomari(
      [{ id: 5, name: '北京电信', clients: [source.uuid], type: 'icmp', target: '198.51.100.50', interval: 30 }],
      [{ task_id: '5', total: 40, valid: 40 }],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.needsCreation).toBe(false)
      expect(planned.verdict).toBe('healthy')
      expect(planned.task).toMatchObject({ id: 5, name: '北京电信', target: '198.51.100.50' })
    }
    finally {
      restore()
    }
  })

  test('keeps the matched display-label name when escalating a dead labeled task to TCP', async () => {
    const restore = mockKomari(
      [{ id: 16, name: '广州电信', clients: [source.uuid], type: 'icmp', target: guangzhouTelecom.landmarkAddress, interval: 30 }],
      [{ task_id: '16', total: 40, valid: 0 }],
    )
    try {
      const planned = await planEntryProbeTask(source, guangzhouTelecom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.probe).toEqual({ type: 'tcp', port: 53 })
      expect(planned.task.name).toBe('广州电信')
      // 换到 TCP 后目标也换成同运营商同城市的解析器：骨干网关不接 TCP。
      expect(planned.task.target).toBe(`${guangzhouTelecom.dnsAddress}:53`)
    }
    finally {
      restore()
    }
  })

  test('matches an existing task named after the display label instead of the community taskFilter', async () => {
    // 广州入口标签是「广州电信」，惯用任务名是「广东电信」；站长照界面标签建的
    // 任务也必须能被认领，不能重复创建。
    const restore = mockKomari(
      [{ id: 6, name: '广州电信', clients: [source.uuid], type: 'icmp', target: '198.51.100.60', interval: 30 }],
      [{ task_id: '6', total: 10, valid: 5 }],
    )
    try {
      const planned = await planEntryProbeTask(source, guangzhouTelecom)
      expect(planned.needsCreation).toBe(false)
      expect(planned.task.id).toBe(6)
    }
    finally {
      restore()
    }
  })

  test('escalates to the next probe once the bound task is proven dead, and flags the old one for retirement', async () => {
    const restore = mockKomari(
      [{ id: 7, name: '北京电信', clients: [source.uuid], type: 'icmp', target: beijingTelecom.landmarkAddress, interval: 30 }],
      [{ task_id: '7', total: 40, valid: 0 }],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.switchedFrom).toEqual({ type: 'icmp' })
      expect(planned.probe).toEqual({ type: 'tcp', port: 53 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.retiredTasks.map(task => task.id)).toEqual([7])
      expect(planned.exhausted).toBe(false)
      // 换挡后任务名必须保持不变——不像第 2 段那样另起带后缀的新名字，否则
      // 站长在 Komari 里按名字识别的入口探测就找不到了。
      expect(planned.task.name).toBe('北京电信')
      expect(planned.task.target).toBe(`${beijingTelecom.dnsAddress}:53`)
    }
    finally {
      restore()
    }
  })

  test('reports exhaustion once the last ladder rung is also dead, and does not propose retiring it', async () => {
    // 入口阶梯只有 ICMP → TCP 53 两档，TCP 53 判死就到头了。
    const restore = mockKomari(
      [{ id: 8, name: '北京电信', clients: [source.uuid], type: 'tcp', target: `${beijingTelecom.dnsAddress}:53`, interval: 30 }],
      [{ task_id: '8', total: 40, valid: 0 }],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.exhausted).toBe(true)
      expect(planned.verdict).toBe('dead')
      expect(planned.needsCreation).toBe(false)
      expect(planned.retiredTasks).toEqual([])
      expect(planned.task.id).toBe(8)
    }
    finally {
      restore()
    }
  })

  test('starts at TCP instead of ICMP when only TCP is proven to work on this relay', async () => {
    // 这台线路机上只有 TCP 在出数，说明它发不出 ICMP。第 2 段会照抄 443，入口
    // 段不能：运营商测速点上 443 没有意义，只能落回入口阶梯自己的 TCP 档。
    const restore = mockKomari(
      [{ id: 9, name: 'unrelated-task', clients: [source.uuid], type: 'tcp', target: '198.51.100.9:443', interval: 30 }],
      [{ task_id: '9', total: 40, valid: 40 }],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.probe).toEqual({ type: 'tcp', port: 53 })
      expect(planned.task.target).toBe(`${beijingTelecom.dnsAddress}:53`)
    }
    finally {
      restore()
    }
  })

  test('rejects planning when the source is invalid', async () => {
    await expect(planEntryProbeTask({ uuid: '', name: 'Ghost' }, beijingTelecom)).rejects.toThrow('线路机已失效')
  })

  test('binds the healthy one among duplicate same-named tasks and flags the dead one for cleanup, without proposing a new one', async () => {
    // 换挡新建成功、旧的还没删掉时会短暂出现两个同名任务；这里必须稳定选中
    // 健康的那个继续用，而不是把"看到两个"误判成"一个都不存在"又建第三个。
    const restore = mockKomari(
      [
        { id: 10, name: '北京电信', clients: [source.uuid], type: 'icmp', target: beijingTelecom.landmarkAddress, interval: 30 },
        { id: 11, name: '北京电信', clients: [source.uuid], type: 'tcp', target: `${beijingTelecom.dnsAddress}:53`, interval: 30 },
      ],
      [
        { task_id: '10', total: 40, valid: 0 },
        { task_id: '11', total: 40, valid: 40 },
      ],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.needsCreation).toBe(false)
      expect(planned.verdict).toBe('healthy')
      expect(planned.task.id).toBe(11)
      expect(planned.retiredTasks.map(task => task.id)).toEqual([10])
    }
    finally {
      restore()
    }
  })

  test('stays on the same pick across repeated re-planning while cleanup has not caught up yet', async () => {
    const restore = mockKomari(
      [
        { id: 12, name: '北京电信', clients: [source.uuid], type: 'icmp', target: beijingTelecom.landmarkAddress, interval: 30 },
        { id: 13, name: '北京电信', clients: [source.uuid], type: 'tcp', target: `${beijingTelecom.dnsAddress}:53`, interval: 30 },
      ],
      [
        { task_id: '12', total: 40, valid: 0 },
        { task_id: '13', total: 40, valid: 40 },
      ],
    )
    try {
      const first = await planEntryProbeTask(source, beijingTelecom)
      const second = await planEntryProbeTask(source, beijingTelecom, { fresh: true })
      expect(first.task.id).toBe(13)
      expect(second.task.id).toBe(13)
      expect(first.needsCreation).toBe(false)
      expect(second.needsCreation).toBe(false)
    }
    finally {
      restore()
    }
  })

  test('escalates past duplicate dead tasks, retiring all of them, when every candidate is dead', async () => {
    const restore = mockKomari(
      [
        { id: 14, name: '北京电信', clients: [source.uuid], type: 'icmp', target: beijingTelecom.landmarkAddress, interval: 30 },
        { id: 15, name: '北京电信', clients: [source.uuid], type: 'icmp', target: beijingTelecom.landmarkAddress, interval: 30 },
      ],
      [
        { task_id: '14', total: 40, valid: 0 },
        { task_id: '15', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planEntryProbeTask(source, beijingTelecom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'icmp' })
      expect(planned.probe).toEqual({ type: 'tcp', port: 53 })
      expect(planned.retiredTasks.map(task => task.id).sort()).toEqual([14, 15])
    }
    finally {
      restore()
    }
  })
})
