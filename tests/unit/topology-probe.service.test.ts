import type { AdminPingTask, TopologyHopProbe } from '../../src/services/ping-task.service'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '../../src/constants/ops'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import {
  buildTopologyEntryTarget,
  buildTopologyHopTarget,
  describeTopologyHopProbe,
  invalidateAdminPingTasksCache,
  topologyHopTaskName,
} from '../../src/services/ping-task.service'
import {
  assessHopTask,
  chooseInitialHopProbe,
  getHopTaskSamples,
  LADDER,
  loadSourceProbeProfile,
  nextLadderProbe,
  planEntryProbeTask,
  planWorkingHopTask,
} from '../../src/services/topology-probe.service'
import { resetSharedRpc } from '../../src/utils/rpc'
import { createCustomTopologyProbe, getTopologyProbe, getTopologyProbeTarget, topologyEntryTaskName } from '../../src/utils/topologyPresets'

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

  test('starts at TCP 443 when both 443 and 80 already have healthy samples', async () => {
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

  test('always starts a new line at TCP 443 when ICMP is unusable, regardless of which port other tasks use most', async () => {
    // V.PS-SEA 上有两个健康的运营商入口任务用 TCP 80，一个用 TCP 443；这些任务
    // 打的是别的目的地，只能证明这台线路机能发 TCP，不能证明新落地机开着 80。
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
      expect(chooseInitialHopProbe(await loadSourceProbeProfile(source.uuid))).toEqual({ type: 'tcp', port: 443 })
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
  test('icmp-only mode migrates a healthy legacy TCP binding instead of relabeling its failures as packet loss', async () => {
    const tcpTaskName = 'Transit-Relay-JP-to-Exit-SG-tcp-22'
    const restore = mockKomari(
      [{ id: 1, name: tcpTaskName, clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:22`, interval: 30 }],
      [{ task_id: '1', name: tcpTaskName, total: 100, valid: 100 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, tcpTaskName, { icmpOnly: true })
      expect(planned.probe).toEqual({ type: 'icmp' })
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'tcp', port: 22 })
      expect(planned.task).toMatchObject({
        name: 'Transit-Relay-JP-to-Exit-SG',
        type: 'icmp',
        target: landing.ipv4,
        clients: [source.uuid],
      })
    }
    finally {
      restore()
    }
  })

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

  test('advances past a dead unbound initial TCP 443 instead of binding it for a wasted round', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'telecom', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 },
        { id: 9, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 },
      ],
      [
        { task_id: '1', name: 'telecom', total: 100, valid: 100 },
        { task_id: '9', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing)
      expect(planned.probe).toEqual({ type: 'tcp', port: 80 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'tcp', port: 443 })
    }
    finally {
      restore()
    }
  })

  test('binds the healthy same-named hop instead of climbing the ladder or creating a third task', async () => {
    const restore = mockKomari(
      [
        { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
      ],
      [
        { task_id: '1', total: 40, valid: 0 },
        { task_id: '2', total: 40, valid: 40 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG')
      expect(planned.needsCreation).toBe(false)
      expect(planned.verdict).toBe('healthy')
      expect(planned.task.id).toBe(2)
      expect(planned.probe).toEqual({ type: 'icmp' })
      expect(planned.retiredTasks.map(task => task.id)).toEqual([1])
    }
    finally {
      restore()
    }
  })

  test('keeps a pending duplicate probe instead of escalating from an older dead task', async () => {
    const restore = mockKomari(
      [
        { id: 1, weight: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
        { id: 2, weight: 2, name: 'Transit-Relay-JP-to-Exit-SG-2', clients: [source.uuid], type: 'icmp', target: landing.ipv4, interval: 30 },
      ],
      [
        { task_id: '1', total: 40, valid: 0 },
        { task_id: '2', total: 2, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing)
      expect(planned.task.id).toBe(2)
      expect(planned.verdict).toBe('pending')
      expect(planned.needsCreation).toBe(false)
      expect(planned.switchedFrom).toBeNull()
      expect(planned.retiredTasks.map(task => task.id)).toEqual([1])
    }
    finally {
      restore()
    }
  })

  test('drafts IPv6 when a dual-stack landing already has a dead IPv4 TCP 443 hop', async () => {
    const dualLanding = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20', ipv6: '2001:db8::20' }
    const restore = mockKomari(
      [
        { id: 1, name: 'telecom', clients: [source.uuid], type: 'tcp', target: '198.51.100.2:443', interval: 30 },
        { id: 9, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', clients: [source.uuid], type: 'tcp', target: '203.0.113.20:443', interval: 30 },
      ],
      [
        { task_id: '1', name: 'telecom', total: 100, valid: 100 },
        { task_id: '9', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, dualLanding)
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.targetAddress).toBe('2001:db8::20')
      expect(planned.task.target).toContain('2001:db8::20')
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

  test('escalates a dead TCP 80 binding forward to TCP 22 instead of stalling', async () => {
    // 复现事故现场：北京电信 -> Riven-JP -> V.PS-SEA -> V.PS-US-SJC，任务 44 绑
    // 在落地机不开放的 TCP 80 上，累计 62 次失败后必须继续换到 TCP 22。
    const relay = { uuid: 'vps-sea-uuid', name: 'V.PS-SEA', ipv4: '198.51.100.9' }
    const exit = { uuid: 'vps-sjc-uuid', name: 'V.PS-US-SJC', ipv4: '146.19.116.171' }
    const taskName = 'Transit-V.PS-SEA-to-V.PS-US-SJC-tcp-80'
    const restore = mockKomari(
      [{ id: 44, name: taskName, clients: [relay.uuid], type: 'tcp', target: `${exit.ipv4}:80`, interval: 30 }],
      [{ entity_id: relay.uuid, task_id: '44', total: 62, valid: 0 }],
    )
    try {
      const planned = await planWorkingHopTask(relay, exit, taskName)
      expect(planned.probe).toEqual({ type: 'tcp', port: 22 })
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'tcp', port: 80 })
      expect(planned.task.name).toBe('Transit-V.PS-SEA-to-V.PS-US-SJC-tcp-22')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([44])
    }
    finally {
      restore()
    }
  })

  test('keeps a bound task pending instead of switching after only one or two failed samples', async () => {
    const restore = mockKomari(
      [{ id: 44, name: 'Transit-Relay-JP-to-Exit-SG-tcp-80', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:80`, interval: 30 }],
      [{ task_id: '44', total: 2, valid: 0 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing, 'Transit-Relay-JP-to-Exit-SG-tcp-80')
      expect(planned.verdict).toBe('pending')
      expect(planned.needsCreation).toBe(false)
      expect(planned.switchedFrom).toBeNull()
      expect(planned.task.name).toBe('Transit-Relay-JP-to-Exit-SG-tcp-80')
    }
    finally {
      restore()
    }
  })

  test('reuses an existing healthy hop task for the landing instead of creating a duplicate', async () => {
    const restore = mockKomari(
      [{ id: 30, name: 'existing-tcp-443', clients: [source.uuid], type: 'tcp', target: `${landing.ipv4}:443`, interval: 30 }],
      [{ task_id: '30', total: 40, valid: 40 }],
    )
    try {
      const planned = await planWorkingHopTask(source, landing)
      expect(planned.task.name).toBe('existing-tcp-443')
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.verdict).toBe('healthy')
      expect(planned.needsCreation).toBe(false)
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

  test('does not recreate ICMP just because another source can ping the landing', async () => {
    const otherSource = 'other-relay-uuid'
    const restore = mockKomari(
      [
        { id: 9, name: 'unrelated-tcp', clients: [source.uuid], type: 'tcp', target: '198.51.100.9:443', interval: 30 },
        { id: 18, name: 'other-icmp', clients: [otherSource], type: 'icmp', target: landing.ipv4, interval: 30 },
      ],
      [
        { entity_id: source.uuid, task_id: '9', total: 40, valid: 39 },
        { entity_id: otherSource, task_id: '18', total: 40, valid: 39 },
      ],
    )
    try {
      const planned = await planWorkingHopTask(source, landing)
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.needsCreation).toBe(true)
    }
    finally {
      restore()
    }
  })

  test('does not judge a new same-named TCP entry from the dead ICMP sample bucket', () => {
    const profile = {
      sourceUuid: source.uuid,
      tasks: [
        { id: 55, name: '北京电信', clients: [source.uuid], type: 'icmp' as const, target: '219.141.140.10', interval: 30 },
        { id: 56, name: '北京电信', clients: [source.uuid], type: 'tcp' as const, target: '219.141.136.10:53', interval: 30 },
      ],
      samplesByTaskId: new Map([['55', { total: 40, valid: 0 }]]),
      samplesByTaskName: new Map([['北京电信', { total: 40, valid: 0 }]]),
      observedSamplesByTaskId: new Map([['55', { total: 40, valid: 0 }]]),
    }
    expect(getHopTaskSamples(profile, { id: 55, name: '北京电信' })).toEqual({ total: 40, valid: 0 })
    expect(getHopTaskSamples(profile, { id: 56, name: '北京电信' })).toBeNull()
    expect(assessHopTask(profile, { id: 56, name: '北京电信' })).toBe('pending')
  })

  test('does not inherit retired ICMP name-bucket stats after the old task is deleted', () => {
    const profile = {
      sourceUuid: source.uuid,
      tasks: [
        { id: 56, name: '北京电信', clients: [source.uuid], type: 'tcp' as const, target: '219.141.136.10:53', interval: 30 },
      ],
      samplesByTaskId: new Map(),
      samplesByTaskName: new Map([['北京电信', { total: 40, valid: 0 }]]),
      observedSamplesByTaskId: new Map([['55', { total: 40, valid: 0 }]]),
    }
    expect(getHopTaskSamples(profile, { id: 56, name: '北京电信' })).toBeNull()
    expect(assessHopTask(profile, { id: 56, name: '北京电信' })).toBe('pending')
  })

  test('does not restart an unknown TCP port at ICMP when this source cannot send ICMP', () => {
    const profile = {
      sourceUuid: source.uuid,
      tasks: [
        { id: 9, name: 'unrelated-tcp', clients: [source.uuid], type: 'tcp' as const, target: '198.51.100.9:443', interval: 30 },
      ],
      samplesByTaskId: new Map([['9', { total: 40, valid: 40 }]]),
      samplesByTaskName: new Map(),
      observedSamplesByTaskId: new Map(),
    }
    expect(nextLadderProbe(profile, { type: 'tcp', port: 20002 }, [], LADDER)).toEqual({ type: 'tcp', port: 443 })
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

  test('uses common service ports instead of DNS 53 when a custom entry ICMP task is dead', async () => {
    const custom = createCustomTopologyProbe('北京联通家宽', '111.197.38.247')!
    const restore = mockKomari(
      [{ id: 56, name: custom.taskFilter, clients: [source.uuid], type: 'icmp', target: custom.landmarkAddress, interval: 30 }],
      [{ task_id: '56', total: 40, valid: 0 }],
    )
    try {
      const planned = await planEntryProbeTask(source, custom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'icmp' })
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.task.name).toBe(topologyEntryTaskName(custom, { type: 'tcp', port: 443 }))
      expect(planned.task.target).toBe('111.197.38.247:443')
    }
    finally {
      restore()
    }
  })

  test('migrates a dead legacy custom TCP 53 task to TCP 443', async () => {
    const custom = createCustomTopologyProbe('北京联通家宽', '111.197.38.247')!
    const restore = mockKomari(
      [{ id: 57, name: custom.taskFilter, clients: [source.uuid], type: 'tcp', target: '111.197.38.247:53', interval: 30 }],
      [{ task_id: '57', total: 40, valid: 0 }],
    )
    try {
      const planned = await planEntryProbeTask(source, custom)
      expect(planned.needsCreation).toBe(true)
      expect(planned.switchedFrom).toEqual({ type: 'tcp', port: 53 })
      expect(planned.probe).toEqual({ type: 'tcp', port: 443 })
      expect(planned.task.name).toBe(topologyEntryTaskName(custom, { type: 'tcp', port: 443 }))
      expect(planned.task.target).toBe('111.197.38.247:443')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([57])
    }
    finally {
      restore()
    }
  })

  test('disambiguates legacy same-named custom tasks even after the probe ladder is exhausted', async () => {
    const custom = createCustomTopologyProbe('北京联通家宽', '111.197.38.247')!
    const restore = mockKomari(
      [
        { id: 47, name: custom.taskFilter, clients: [source.uuid], type: 'tcp', target: '111.197.38.247:443', interval: 30 },
        { id: 50, name: custom.taskFilter, clients: [source.uuid], type: 'tcp', target: '111.197.38.247:22', interval: 30 },
      ],
      [
        { task_id: '47', total: 40, valid: 0 },
        { task_id: '50', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planEntryProbeTask(source, custom, { currentTaskName: custom.taskFilter })
      expect(planned.needsCreation).toBe(true)
      expect(planned.exhausted).toBe(false)
      expect(planned.switchedFrom).toBeNull()
      expect(planned.probe).toEqual({ type: 'tcp', port: 22 })
      expect(planned.task.name).toBe(topologyEntryTaskName(custom, { type: 'tcp', port: 22 }))
      expect(planned.task.target).toBe('111.197.38.247:22')
      expect(planned.retiredTasks.map(task => task.id)).toEqual([50, 47])
    }
    finally {
      restore()
    }
  })

  test('migrates a single leftover unsuffixed custom task at the last rung to a unique name', async () => {
    const custom = createCustomTopologyProbe('北京联通家宽', '111.197.38.247')!
    const restore = mockKomari(
      [
        { id: 50, name: custom.taskFilter, clients: [source.uuid], type: 'tcp', target: '111.197.38.247:22', interval: 30 },
      ],
      [
        { task_id: '50', total: 40, valid: 0 },
      ],
    )
    try {
      const planned = await planEntryProbeTask(source, custom, { currentTaskName: custom.taskFilter })
      expect(planned.needsCreation).toBe(true)
      expect(planned.exhausted).toBe(false)
      expect(planned.probe).toEqual({ type: 'tcp', port: 22 })
      expect(planned.task.name).toBe(topologyEntryTaskName(custom, { type: 'tcp', port: 22 }))
      expect(planned.retiredTasks.map(task => task.id)).toEqual([50])
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

/**
 * 系统性穷举阶梯降级：不同 fix 分别补过「跳过一个死档」「自定义入口换挡改名」
 * 「判死样本数边界」等个案，但都是各补各的，没有一次性把「从第几档开始、
 * 中间有几档已死、落到哪一档」这件事按坐标穷举过。这里把三条阶梯
 * （第 2 段、自定义入口、内置入口）各自的降级逻辑按「死档前缀长度 × 落点状态」
 * 系统性跑一遍，取代零散补的个案回归测试。
 */
describe('probe ladder escalation matrix', () => {
  type RungState = 'missing' | 'pending' | 'healthy' | 'dead'

  interface LadderRung {
    probe: TopologyHopProbe
    name: string
    target: string
  }

  function samplesForState(state: Exclude<RungState, 'missing'>): { total: number, valid: number } {
    if (state === 'pending')
      return { total: 1, valid: 0 }
    if (state === 'healthy')
      return { total: 40, valid: 40 }
    return { total: 40, valid: 0 }
  }

  function buildLadderFixture(
    rungs: readonly LadderRung[],
    states: readonly RungState[],
  ): { tasks: AdminPingTask[], stats: StatFixture[] } {
    const tasks: AdminPingTask[] = []
    const stats: StatFixture[] = []
    rungs.forEach((rung, index) => {
      const state = states[index]
      if (!state || state === 'missing')
        return
      const id = index + 1
      tasks.push({ id, name: rung.name, clients: [source.uuid], type: rung.probe.type, target: rung.target, interval: 30 })
      const samples = samplesForState(state)
      stats.push({ task_id: String(id), total: samples.total, valid: samples.valid })
    })
    return { tasks, stats }
  }

  describe('second-hop ladder (planWorkingHopTask)', () => {
    const rungs: LadderRung[] = OPS_TOPOLOGY_HOP_PROBE_LADDER.map(probe => ({
      probe,
      name: topologyHopTaskName(source, landing, probe),
      target: buildTopologyHopTarget(landing, probe),
    }))

    for (let deadPrefix = 0; deadPrefix <= rungs.length; deadPrefix++) {
      const deadIds = Array.from({ length: deadPrefix }, (_, index) => index + 1)

      if (deadPrefix === rungs.length) {
        test(`exhausts once all ${deadPrefix} rungs are dead`, async () => {
          const { tasks, stats } = buildLadderFixture(rungs, rungs.map(() => 'dead'))
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planWorkingHopTask(source, landing, rungs[0]!.name)
            expect(planned.exhausted).toBe(true)
            expect(planned.verdict).toBe('dead')
            expect(planned.needsCreation).toBe(false)
            expect(planned.switchedFrom).toBeNull()
            // 阶梯走完时保留全部死档记录，删掉只会让下次复检重新建回来。
            expect(planned.retiredTasks).toEqual([])
          }
          finally {
            restore()
          }
        })
        continue
      }

      for (const landingState of ['missing', 'pending', 'healthy'] as const) {
        test(`skips ${deadPrefix} dead rung(s) and lands on ${describeTopologyHopProbe(rungs[deadPrefix]!.probe)} (${landingState})`, async () => {
          const states: RungState[] = rungs.map((_, index) => {
            if (index < deadPrefix)
              return 'dead'
            return index === deadPrefix ? landingState : 'missing'
          })
          const { tasks, stats } = buildLadderFixture(rungs, states)
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planWorkingHopTask(source, landing, rungs[0]!.name)
            expect(planned.probe).toEqual(rungs[deadPrefix]!.probe)
            expect(planned.exhausted).toBe(false)
            expect(planned.switchedFrom).toEqual(deadPrefix === 0 ? null : rungs[0]!.probe)
            if (landingState === 'missing') {
              expect(planned.needsCreation).toBe(true)
              expect(planned.task.name).toBe(rungs[deadPrefix]!.name)
              expect(planned.task.target).toBe(rungs[deadPrefix]!.target)
            }
            else {
              expect(planned.needsCreation).toBe(false)
              expect(planned.verdict).toBe(landingState)
              expect(planned.task.id).toBe(deadPrefix + 1)
            }
            expect(planned.retiredTasks.map(task => task.id).sort((a, b) => a - b)).toEqual(deadIds)
          }
          finally {
            restore()
          }
        })
      }
    }
  })

  describe('custom entry ladder (planEntryProbeTask)', () => {
    const custom = createCustomTopologyProbe('矩阵自定义入口', '198.51.100.200')!
    const rungs: LadderRung[] = OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER.map((probe) => {
      const targetHost = getTopologyProbeTarget(custom, probe)
      return { probe, name: topologyEntryTaskName(custom, probe), target: buildTopologyEntryTarget(targetHost, probe) }
    })

    for (let deadPrefix = 0; deadPrefix <= rungs.length; deadPrefix++) {
      const deadIds = Array.from({ length: deadPrefix }, (_, index) => index + 1)

      if (deadPrefix === rungs.length) {
        test(`exhausts once all ${deadPrefix} rungs are dead`, async () => {
          const { tasks, stats } = buildLadderFixture(rungs, rungs.map(() => 'dead'))
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planEntryProbeTask(source, custom)
            expect(planned.exhausted).toBe(true)
            expect(planned.verdict).toBe('dead')
            expect(planned.needsCreation).toBe(false)
          }
          finally {
            restore()
          }
        })
        continue
      }

      for (const landingState of ['missing', 'pending', 'healthy'] as const) {
        test(`skips ${deadPrefix} dead rung(s) and lands on ${describeTopologyHopProbe(rungs[deadPrefix]!.probe)} (${landingState})`, async () => {
          const states: RungState[] = rungs.map((_, index) => {
            if (index < deadPrefix)
              return 'dead'
            return index === deadPrefix ? landingState : 'missing'
          })
          const { tasks, stats } = buildLadderFixture(rungs, states)
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planEntryProbeTask(source, custom)
            expect(planned.probe).toEqual(rungs[deadPrefix]!.probe)
            expect(planned.exhausted).toBe(false)
            // 只有真正落到「新建」才算换挡；命中一个健康/待定的候选时不算换挡，
            // 即便中间跳过了几个死档——这与第 2 段阶梯不同，第 2 段只要绑定
            // 判死就报告换挡，不看落点状态。
            expect(planned.switchedFrom).toEqual(deadPrefix > 0 && landingState === 'missing' ? rungs[deadPrefix - 1]!.probe : null)
            if (landingState === 'missing') {
              expect(planned.needsCreation).toBe(true)
              expect(planned.task.target).toBe(rungs[deadPrefix]!.target)
              // 自定义入口换挡时任务名带协议/端口后缀，从零新建时退回纯 taskFilter。
              expect(planned.task.name).toBe(deadPrefix === 0 ? custom.taskFilter : rungs[deadPrefix]!.name)
            }
            else {
              expect(planned.needsCreation).toBe(false)
              expect(planned.verdict).toBe(landingState)
            }
            expect(planned.retiredTasks.map(task => task.id).sort((a, b) => a - b)).toEqual(deadIds)
          }
          finally {
            restore()
          }
        })
      }
    }
  })

  describe('built-in entry ladder (planEntryProbeTask)', () => {
    const beijingTelecom = getTopologyProbe('beijing-telecom')
    const rungs: LadderRung[] = OPS_TOPOLOGY_ENTRY_PROBE_LADDER.map((probe) => {
      const targetHost = getTopologyProbeTarget(beijingTelecom, probe)
      return { probe, name: topologyEntryTaskName(beijingTelecom, probe), target: buildTopologyEntryTarget(targetHost, probe) }
    })

    for (let deadPrefix = 0; deadPrefix <= rungs.length; deadPrefix++) {
      const deadIds = Array.from({ length: deadPrefix }, (_, index) => index + 1)

      if (deadPrefix === rungs.length) {
        test(`exhausts once all ${deadPrefix} rungs are dead`, async () => {
          const { tasks, stats } = buildLadderFixture(rungs, rungs.map(() => 'dead'))
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planEntryProbeTask(source, beijingTelecom)
            expect(planned.exhausted).toBe(true)
            expect(planned.verdict).toBe('dead')
            expect(planned.needsCreation).toBe(false)
          }
          finally {
            restore()
          }
        })
        continue
      }

      for (const landingState of ['missing', 'pending', 'healthy'] as const) {
        test(`skips ${deadPrefix} dead rung(s) and lands on ${describeTopologyHopProbe(rungs[deadPrefix]!.probe)} (${landingState})`, async () => {
          const states: RungState[] = rungs.map((_, index) => {
            if (index < deadPrefix)
              return 'dead'
            return index === deadPrefix ? landingState : 'missing'
          })
          const { tasks, stats } = buildLadderFixture(rungs, states)
          const restore = mockKomari(tasks, stats)
          try {
            const planned = await planEntryProbeTask(source, beijingTelecom)
            expect(planned.probe).toEqual(rungs[deadPrefix]!.probe)
            expect(planned.exhausted).toBe(false)
            // 只有真正落到「新建」才算换挡；命中一个健康/待定的候选时不算换挡，
            // 即便中间跳过了几个死档——这与第 2 段阶梯不同，第 2 段只要绑定
            // 判死就报告换挡，不看落点状态。
            expect(planned.switchedFrom).toEqual(deadPrefix > 0 && landingState === 'missing' ? rungs[deadPrefix - 1]!.probe : null)
            if (landingState === 'missing') {
              expect(planned.needsCreation).toBe(true)
              expect(planned.task.target).toBe(rungs[deadPrefix]!.target)
              // 内置入口换挡沿用旧任务名（界面按名字识别），只有从零新建时才是 taskFilter。
              expect(planned.task.name).toBe(deadPrefix === 0 ? beijingTelecom.taskFilter : rungs[deadPrefix - 1]!.name)
            }
            else {
              expect(planned.needsCreation).toBe(false)
              expect(planned.verdict).toBe(landingState)
            }
            expect(planned.retiredTasks.map(task => task.id).sort((a, b) => a - b)).toEqual(deadIds)
          }
          finally {
            restore()
          }
        })
      }
    }
  })
})

/**
 * `topology-probe.service.ts` 里有两处按版本号写死的迁移兼容分支（"v1.3.2 曾…"
 * "v1.3.3 以前…"），处理的是站点还没跑过对应新版主题时留下的旧任务命名。这类
 * 分支删不删得看有没有站点还没升级过，代码本身判断不出来，只能留给维护者
 * 定期回头看一眼。这条测试到了目标版本还没人挪过阈值就会失败，逼着做一次
 * 有意识的判断——继续保留就把 REMOVAL_REVIEW_VERSION 往后挪并说明理由，
 * 判断可以删了就顺手把两处兼容分支和这条测试一起删掉。
 */
describe('legacy custom-entry migration shims', () => {
  const REMOVAL_REVIEW_VERSION = '1.6.0'

  test(`flags topology-probe.service.ts's v1.3.2/v1.3.3 custom-entry migration shims for review once the theme reaches ${REMOVAL_REVIEW_VERSION}`, () => {
    const themeJson = JSON.parse(readFileSync(new URL('../../komari-theme.json', import.meta.url), 'utf8')) as { version: string }
    const [major = 0, minor = 0] = themeJson.version.split('.').map(Number)
    const [reviewMajor = 0, reviewMinor = 0] = REMOVAL_REVIEW_VERSION.split('.').map(Number)
    const reachedReviewVersion = major > reviewMajor || (major === reviewMajor && minor >= reviewMinor)
    expect(
      reachedReviewVersion,
      `komari-theme.json is now ${themeJson.version}. Go re-check the "v1.3.2 曾…" / "v1.3.3 以前…" custom-entry migration branches in src/services/topology-entry-probe.service.ts (inside planEntryProbeTask). If deployed stations have long since migrated, delete both branches and this test; otherwise bump REMOVAL_REVIEW_VERSION here with a one-line reason.`,
    ).toBe(false)
  })
})
