import type { AdminPingTask } from '../../src/services/ping-task.service'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { isAuthenticated, setAuthSessionFromLogin } from '../../src/services/auth.service'
import { buildTopologyHopTarget, createTopologyEntryProbeTask, deleteTopologyPingTasks, ensureTopologyEntryProbeTask, ensureTopologyPingTask, findTopologyEntryProbeTask, findTopologyPingTask, findTopologyPingTaskByName, invalidateAdminPingTasksCache, isPingTaskAssignedToSource, loadAdminPingTaskNamesForNode, loadAdminPingTasks, pingTaskTargetHost, pingTaskTargetPort, planTopologyPingTask, restrictTopologyPingEndpoint, topologyHopTaskName, topologyPingTargets } from '../../src/services/ping-task.service'
import { resetSharedRpc } from '../../src/utils/rpc'
import { getTopologyProbe } from '../../src/utils/topologyPresets'

const source = { uuid: 'relay-uuid', name: 'Relay-JP', ipv4: '192.0.2.10' }
const target = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20', ipv6: '2001:db8::20' }

afterEach(() => {
  mock.restore()
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  // 短 TTL 缓存跨测试用例存活；每个用例都要用自己的 fetch 桩，不能读到上一个
  // 用例缓存下来的任务列表。
  invalidateAdminPingTasksCache()
})

describe('topology Ping task management', () => {
  test('matches an assigned ICMP task by source UUID and target address', () => {
    const tasks: AdminPingTask[] = [
      { id: 1, name: 'wrong-source', clients: ['other'], type: 'icmp', target: target.ipv4, interval: 30 },
      { id: 2, name: 'ssh-check', clients: [source.uuid], type: 'tcp', target: `${target.ipv4}:22`, interval: 30 },
      { id: 3, name: 'right', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
    ]

    expect(topologyPingTargets(target)).toEqual([target.ipv4, target.ipv6])
    expect(pingTaskTargetHost(`${target.ipv4}:22`)).toBe(target.ipv4)
    expect(pingTaskTargetHost('probe.example.com:53')).toBe('probe.example.com')
    expect(pingTaskTargetPort('probe.example.com:53')).toBe(53)
    expect(findTopologyPingTask(tasks, source.uuid, target)?.name).toBe('right')
  })

  test('does not reuse a TCP or HTTP check as the topology hop', () => {
    const tasks: AdminPingTask[] = [
      { id: 2, name: 'ssh-check', clients: [source.uuid], type: 'tcp', target: `${target.ipv4}:22`, interval: 30 },
      { id: 3, name: 'health-check', clients: [source.uuid], type: 'http', target: `http://${target.ipv4}/health`, interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target)).toBeUndefined()
  })

  test('reuses the matching-probe entry task when two tasks share the built-in name', () => {
    const probe = getTopologyProbe('beijing-telecom')
    const tasks: AdminPingTask[] = [
      { id: 55, name: '北京电信', clients: [source.uuid], type: 'icmp', target: probe.landmarkAddress, interval: 30 },
      { id: 56, name: '北京电信', clients: [source.uuid], type: 'tcp', target: `${probe.dnsAddress}:53`, interval: 30 },
    ]
    expect(findTopologyEntryProbeTask(tasks, source.uuid, probe, { type: 'tcp', port: 53 }, '北京电信')?.id).toBe(56)
    expect(findTopologyEntryProbeTask(tasks, source.uuid, probe, { type: 'icmp' }, '北京电信')?.id).toBe(55)
  })

  test('reuses a same-named hop that uniquely targets the current landing', () => {
    const tasks: AdminPingTask[] = [
      { id: 1, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
      { id: 2, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: '203.0.113.99', interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target)?.id).toBe(1)
  })

  test('restricts a dual-stack landing to the planned address family', () => {
    expect(restrictTopologyPingEndpoint(target, '2001:db8::20')).toEqual({
      uuid: target.uuid,
      name: target.name,
      ipv4: undefined,
      ipv6: '2001:db8::20',
    })
    expect(restrictTopologyPingEndpoint(target, '203.0.113.20:443').ipv6).toBeUndefined()
    expect(findTopologyPingTask([
      { id: 1, name: 'v4', clients: [source.uuid], type: 'tcp', target: `${target.ipv4}:443`, interval: 30 },
      { id: 2, name: 'v6', clients: [source.uuid], type: 'tcp', target: `[${target.ipv6}]:443`, interval: 30 },
    ], source.uuid, restrictTopologyPingEndpoint(target, target.ipv6!), { type: 'tcp', port: 443 })?.id).toBe(2)
  })

  test('reuses the lowest-id hop when two same-named hops target the current landing with the same probe', () => {
    const tasks: AdminPingTask[] = [
      { id: 2, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
      { id: 1, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target)?.id).toBe(1)
  })

  test('requires explicit source assignment even when a task is default-on', () => {
    const globalTask: AdminPingTask = {
      id: 1,
      name: 'global',
      clients: [],
      default_on: true,
      type: 'icmp',
      target: target.ipv4,
      interval: 30,
    }
    expect(isPingTaskAssignedToSource(globalTask, source.uuid)).toBe(false)
    expect(findTopologyPingTask([globalTask], source.uuid, target)).toBeUndefined()
    const assignedTask = { ...globalTask, clients: [source.uuid] }
    expect(findTopologyPingTask([assignedTask], source.uuid, target)).toEqual(assignedTask)
    expect(findTopologyPingTask([
      assignedTask,
      { ...assignedTask, id: 2, target: '203.0.113.99' },
    ], source.uuid, target)?.id).toBe(1)
  })

  test('normalizes equivalent IPv6 forms and rejects invalid addresses and task types', () => {
    const expandedTarget = { ipv6: '2001:0db8:0:0:0:0:0:20' }
    expect(topologyPingTargets(expandedTarget)).toEqual(['2001:db8::20'])
    expect(topologyPingTargets({ ipv6: '::::' })).toEqual([])
    expect(findTopologyPingTask([{
      id: 1,
      name: 'unsupported',
      clients: [source.uuid],
      type: 'dns',
      target: '2001:db8::20',
      interval: 30,
    }], source.uuid, expandedTarget)).toBeUndefined()
  })

  test('lists only unambiguous tasks assigned to the selected source', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method !== 'admin:getAllPingTasks')
        throw new Error(`Unexpected RPC method: ${request.method}`)
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: [
          { id: 1, name: 'default-only', clients: [], default_on: true, type: 'icmp', target: '198.51.100.1', interval: 30 },
          { id: 2, name: 'unique', clients: [source.uuid], default_on: false, type: 'icmp', target: '198.51.100.2', interval: 30 },
          { id: 3, name: 'duplicate', clients: [source.uuid], default_on: false, type: 'icmp', target: '198.51.100.3', interval: 30 },
          { id: 4, name: 'duplicate', clients: [], default_on: true, type: 'icmp', target: '198.51.100.4', interval: 30 },
          { id: 5, name: 'other', clients: ['other'], default_on: false, type: 'icmp', target: '198.51.100.5', interval: 30 },
          { id: 6, name: 'unsupported', clients: [source.uuid], default_on: false, type: 'dns', target: '198.51.100.6', interval: 30 },
        ],
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      await expect(loadAdminPingTaskNamesForNode(source.uuid)).resolves.toEqual(['unique', 'duplicate'])
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('plans without creating, then creates a missing task once for concurrent saves', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        tasks.push({ ...request.params!, id: 10 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const planned = await planTopologyPingTask(source, target)
      expect(planned).toMatchObject({ needsCreation: true, task: { name: 'Transit-Relay-JP-to-Exit-SG' } })
      expect(addCalls).toBe(0)

      const [first, second] = await Promise.all([
        ensureTopologyPingTask(source, target),
        ensureTopologyPingTask(source, target),
      ])
      expect(first.task.name).toBe('Transit-Relay-JP-to-Exit-SG')
      expect(second.task.name).toBe(first.task.name)
      expect(addCalls).toBe(1)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('an abort after mutation starts does not fail shared reconciliation', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    let addCalls = 0
    let releaseAdd: (() => void) | undefined
    const holdAdd = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    let sawAdd = false
    let resolveAddStarted: (() => void) | undefined
    const addStarted = new Promise<void>((resolve) => {
      resolveAddStarted = resolve
    })
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        sawAdd = true
        resolveAddStarted?.()
        await holdAdd
        tasks.push({ ...request.params!, id: 12 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const controller = new AbortController()
      const first = ensureTopologyPingTask(source, target, { signal: controller.signal })
      await addStarted
      expect(sawAdd).toBe(true)
      const second = ensureTopologyPingTask(source, target)
      controller.abort()
      releaseAdd?.()
      await expect(first).resolves.toMatchObject({ task: { name: 'Transit-Relay-JP-to-Exit-SG' } })
      await expect(second).resolves.toMatchObject({ task: { name: 'Transit-Relay-JP-to-Exit-SG' } })
      expect(addCalls).toBe(1)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('an aborted caller does not fail a later ensure of the same hop', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        tasks.push({ ...request.params!, id: 11 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const controller = new AbortController()
      controller.abort()
      await expect(ensureTopologyPingTask(source, target, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
      const created = await ensureTopologyPingTask(source, target)
      expect(created.task.name).toBe('Transit-Relay-JP-to-Exit-SG')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('finishes mutation reconciliation after cancellation so callers can clean up', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    let addCalls = 0
    let settled = false
    let mutationAborted = false
    let releaseAdd: (() => void) | undefined
    let resolveAddStarted: (() => void) | undefined
    const addStarted = new Promise<void>((resolve) => {
      resolveAddStarted = resolve
    })
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        resolveAddStarted?.()
        return new Promise<Response>((resolve) => {
          init.signal?.addEventListener('abort', () => {
            mutationAborted = true
          }, { once: true })
          releaseAdd = () => {
            tasks.push({ ...request.params!, id: 13 })
            resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
              headers: { 'Content-Type': 'application/json' },
            }))
          }
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const controller = new AbortController()
      const creating = ensureTopologyPingTask(source, target, { signal: controller.signal })
      void creating.finally(() => {
        settled = true
      })
      await addStarted
      controller.abort()
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseAdd?.()

      await expect(creating).resolves.toMatchObject({ task: { id: 13 }, created: true })
      expect(addCalls).toBe(1)
      expect(mutationAborted).toBe(false)
      expect(tasks).toHaveLength(1)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('treats a committed hop add whose response is lost as created so the caller can compensate', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        tasks.push({ ...request.params!, id: 19 })
        throw new Error('response lost after commit')
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyPingTask(source, target)
      expect(ensured).toMatchObject({ created: true, task: { id: 19 } })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('builds hop targets and names per probe type', () => {
    expect(buildTopologyHopTarget(target)).toBe(target.ipv4)
    expect(buildTopologyHopTarget(target, { type: 'tcp', port: 443 })).toBe(`${target.ipv4}:443`)
    expect(buildTopologyHopTarget({ ipv6: '2001:db8::20' }, { type: 'tcp', port: 22 })).toBe('[2001:db8::20]:22')
    // 端口缺失或越界时回落到默认端口，绝不生成非法目标。
    expect(buildTopologyHopTarget(target, { type: 'tcp' })).toBe(`${target.ipv4}:443`)
    expect(buildTopologyHopTarget(target, { type: 'tcp', port: 70_000 })).toBe(`${target.ipv4}:443`)

    expect(pingTaskTargetPort(target.ipv4)).toBeNull()
    expect(pingTaskTargetPort(`${target.ipv4}:8080`)).toBe(8080)
    expect(pingTaskTargetPort('[2001:db8::20]:22')).toBe(22)

    // ICMP 名字必须保持历史格式，否则已保存的线路会认不回任务。
    expect(topologyHopTaskName(source, target)).toBe('Transit-Relay-JP-to-Exit-SG')
    expect(topologyHopTaskName(source, target, { type: 'tcp', port: 80 })).toBe('Transit-Relay-JP-to-Exit-SG-tcp-80')
    expect(topologyHopTaskName(source, target, { type: 'icmp' }, [
      { name: 'Transit-Relay-JP-to-Exit-SG', type: 'icmp', target: target.ipv4!, clients: [source.uuid], interval: 30 },
      { name: `Transit-Relay-JP-to-Exit-SG-${target.uuid.slice(0, 8)}`, type: 'icmp', target: target.ipv4!, clients: [source.uuid], interval: 30 },
    ])).toBe(`Transit-Relay-JP-to-Exit-SG-${target.uuid.slice(0, 8)}-2`)
  })

  test('matches a TCP hop only on an exact port and resolves bindings by name', () => {
    const tasks: AdminPingTask[] = [
      { id: 1, name: 'icmp-hop', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
      { id: 2, name: 'ssh-check', clients: [source.uuid], type: 'tcp', target: `${target.ipv4}:22`, interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target, { type: 'tcp', port: 22 })?.name).toBe('ssh-check')
    expect(findTopologyPingTask(tasks, source.uuid, target, { type: 'tcp', port: 443 })).toBeUndefined()
    expect(findTopologyPingTask(tasks, source.uuid, target, { type: 'icmp' })?.name).toBe('icmp-hop')

    expect(findTopologyPingTaskByName(tasks, source.uuid, 'ssh-check')?.id).toBe(2)
    expect(findTopologyPingTaskByName(tasks, source.uuid, 'missing')).toBeUndefined()
    expect(findTopologyPingTaskByName(tasks, 'other', 'ssh-check')).toBeUndefined()
    expect(findTopologyPingTaskByName([
      ...tasks,
      { id: 3, name: 'ssh-check', clients: [source.uuid], type: 'tcp', target: '203.0.113.99:22', interval: 30 },
    ], source.uuid, 'ssh-check')).toBeUndefined()
  })

  test('creates a TCP hop task when the caller asks for one', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        tasks.push({ ...request.params!, id: 21 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyPingTask(source, target, { probe: { type: 'tcp', port: 443 } })
      expect(ensured.created).toBe(true)
      expect(ensured.task).toMatchObject({
        name: 'Transit-Relay-JP-to-Exit-SG-tcp-443',
        type: 'tcp',
        target: `${target.ipv4}:443`,
        default_on: false,
        clients: [source.uuid],
      })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects automatic creation when the target has no valid address', async () => {
    await expect(planTopologyPingTask(source, { uuid: 'bad', name: 'No-IP' })).rejects.toThrow('没有可用于 Ping')
  })

  test('invalidates the authenticated session when the admin Ping RPC denies access', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      return new Response('', { status: 403 })
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    try {
      await expect(loadAdminPingTaskNamesForNode(source.uuid)).rejects.toThrow('登录状态已过期')
      expect(isAuthenticated()).toBe(false)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('loadAdminPingTasks caching', () => {
  function mockAdminTaskList(tasks: AdminPingTask[]): { restore: () => void, calls: { me: number, list: number, add: number, delete: number } } {
    const originalFetch = globalThis.fetch
    const calls = { me: 0, list: 0, add: 0, delete: 0 }
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) {
        calls.me += 1
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      }
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        calls.list += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        calls.add += 1
        tasks.push({ ...request.params!, id: 900 + tasks.length })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:deletePingTask') {
        calls.delete += 1
        const removedIds = new Set(((request.params as unknown as { id: number[] } | undefined)?.id ?? []))
        for (let index = tasks.length - 1; index >= 0; index--) {
          if (removedIds.has(tasks[index]!.id!))
            tasks.splice(index, 1)
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch
    return {
      restore: () => { globalThis.fetch = originalFetch },
      calls,
    }
  }

  test('reuses the task list within the TTL, skipping the forced auth check and the RPC', async () => {
    const { restore, calls } = mockAdminTaskList([
      { id: 1, name: 'unique', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
    ])
    try {
      await loadAdminPingTasks()
      await loadAdminPingTasks()
      await loadAdminPingTasks()
      expect(calls.me).toBe(1)
      expect(calls.list).toBe(1)
    }
    finally {
      restore()
    }
  })

  test('options.fresh bypasses a warm cache entry and re-validates the session', async () => {
    const { restore, calls } = mockAdminTaskList([
      { id: 1, name: 'unique', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
    ])
    try {
      await loadAdminPingTasks()
      expect(calls.me).toBe(1)
      expect(calls.list).toBe(1)

      await loadAdminPingTasks({ fresh: true })
      expect(calls.me).toBe(2)
      expect(calls.list).toBe(2)

      // A plain call right after should be served from the cache that the
      // fresh read just repopulated, not trigger a third round-trip.
      await loadAdminPingTasks()
      expect(calls.me).toBe(2)
      expect(calls.list).toBe(2)
    }
    finally {
      restore()
    }
  })

  test('refetches once the cache entry expires', async () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    const { restore, calls } = mockAdminTaskList([
      { id: 1, name: 'unique', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
    ])
    try {
      await loadAdminPingTasks()
      now += 31_000
      await loadAdminPingTasks()
      expect(calls.list).toBe(2)
    }
    finally {
      restore()
      Date.now = originalNow
    }
  })

  test('sees a newly created task immediately, without waiting for the cache to expire', async () => {
    const { restore, calls } = mockAdminTaskList([])
    try {
      const before = await loadAdminPingTasks()
      expect(before).toEqual([])

      await ensureTopologyPingTask(source, target)
      const after = await loadAdminPingTasks()
      expect(after.map(task => task.name)).toContain('Transit-Relay-JP-to-Exit-SG')
      expect(calls.list).toBeGreaterThanOrEqual(3)
    }
    finally {
      restore()
    }
  })

  test('sees a deleted task immediately, without waiting for the cache to expire', async () => {
    const { restore } = mockAdminTaskList([
      { id: 7, name: 'Transit-Relay-JP-to-Exit-SG', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
    ])
    try {
      const before = await loadAdminPingTasks()
      expect(before).toHaveLength(1)

      await deleteTopologyPingTasks([7])
      const after = await loadAdminPingTasks()
      expect(after).toEqual([])
    }
    finally {
      restore()
    }
  })

  test('invalidates the local session when deleting a task is denied', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response('', { status: 403 })) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    try {
      await expect(deleteTopologyPingTasks([7])).resolves.toBe(false)
      expect(isAuthenticated()).toBe(false)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('write-path lookups inside ensureTopologyPingTask never read the stale cache', async () => {
    // 一个空缓存条目已经存在，若创建路径误用缓存，就会看不到自己刚创建的任务。
    const { restore } = mockAdminTaskList([])
    try {
      await loadAdminPingTasks()
      const ensured = await ensureTopologyPingTask(source, target)
      expect(ensured.created).toBe(true)
      expect(ensured.task.name).toBe('Transit-Relay-JP-to-Exit-SG')
    }
    finally {
      restore()
    }
  })

  test('does not expose a cached admin task list after the local session changes', async () => {
    const { restore, calls } = mockAdminTaskList([
      { id: 1, name: 'unique', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 },
    ])
    try {
      await loadAdminPingTasks()
      setAuthSessionFromLogin(false)
      await loadAdminPingTasks()
      expect(calls.me).toBe(2)
      expect(calls.list).toBe(2)
    }
    finally {
      restore()
    }
  })

  test('a fresh read bypasses an older in-flight list and keeps its newer cache value', async () => {
    const originalFetch = globalThis.fetch
    let listCalls = 0
    let releaseOld!: (response: Response) => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve
    })
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve
    })
    const stale = [{ id: 1, name: 'stale', clients: [source.uuid], type: 'icmp', target: '198.51.100.1', interval: 30 }]
    const fresh = [{ id: 2, name: 'fresh', clients: [source.uuid], type: 'icmp', target: '198.51.100.2', interval: 30 }]
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method !== 'admin:getAllPingTasks')
        throw new Error(`Unexpected RPC method: ${request.method}`)
      listCalls += 1
      if (listCalls === 1) {
        markOldStarted()
        return oldResponse
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: fresh }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const oldRead = loadAdminPingTasks()
      await oldStarted
      const freshRead = await loadAdminPingTasks({ fresh: true })
      releaseOld(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: stale }), { headers: { 'Content-Type': 'application/json' } }))
      await oldRead

      expect(freshRead.map(task => task.name)).toEqual(['fresh'])
      expect((await loadAdminPingTasks()).map(task => task.name)).toEqual(['fresh'])
      expect(listCalls).toBe(2)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('ensureTopologyEntryProbeTask', () => {
  const probe = getTopologyProbe('beijing-telecom')

  test('reuses an existing task matched by name, ignoring its actual target', async () => {
    const originalFetch = globalThis.fetch
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks') {
        // 站长手工建的「北京电信」任务指向一个完全不同的地址；只要名字对得上
        // 就必须直接复用，不能因为目标地址不是 landmarkAddress 就当作不存在。
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: [{ id: 7, name: '北京电信', clients: [source.uuid], type: 'icmp', target: '198.51.100.9', interval: 30 }],
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe)
      expect(ensured).toMatchObject({ created: false, task: { id: 7, name: '北京电信', target: '198.51.100.9' } })
      expect(addCalls).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('adds the relay to an existing site-wide task instead of creating a duplicate', async () => {
    // Komari 的 default_on 只对之后新注册的节点生效，所以「站长早就建好了三网
    // 任务、但这台线路机不在 clients 里」是最常见的情况。
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = [{ id: 4, name: '北京电信', clients: ['other'], type: 'icmp', target: '203.0.113.10', interval: 60 }]
    let edited: unknown
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: { tasks?: AdminPingTask[] } }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:editPingTask') {
        edited = request.params
        tasks[0] = { ...tasks[0]!, clients: [...(tasks[0]!.clients ?? []), source.uuid] }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe)
      // created=false：复用来的任务不是主题建的，不记所有权，阶梯换挡也不会删它。
      expect(ensured).toMatchObject({ created: false, task: { id: 4, name: '北京电信' } })
      expect(ensured.task.clients).toContain(source.uuid)
      expect(edited).toMatchObject({ tasks: [{ id: 4, name: '北京电信', clients: ['other', source.uuid] }] })
      expect(addCalls).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reconciles an entry-task edit whose response is lost instead of creating a duplicate', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = [{ id: 14, name: '北京电信', clients: ['other'], type: 'icmp', target: '203.0.113.10', interval: 60 }]
    let editCalls = 0
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:editPingTask') {
        editCalls += 1
        tasks[0] = { ...tasks[0]!, clients: [...(tasks[0]!.clients ?? []), source.uuid] }
        throw new Error('response lost after commit')
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe)
      expect(ensured).toMatchObject({ created: false, task: { id: 14 } })
      expect(ensured.task.clients).toContain(source.uuid)
      expect(editCalls).toBe(1)
      expect(addCalls).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to creating when the existing task probes a different way', async () => {
    // 站里的同名任务是 TCP 443，本次要的是 ICMP：不能拿来当 ICMP 那一档用。
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = [{ id: 5, name: '北京电信', clients: ['other'], type: 'tcp', target: '203.0.113.10:443', interval: 60 }]
    let editCalls = 0
    let added: AdminPingTask | undefined
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:editPingTask') {
        editCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        added = request.params
        tasks.push({ ...request.params!, id: 6 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe)
      expect(editCalls).toBe(0)
      expect(added).toMatchObject({ name: '北京电信', type: 'icmp' })
      expect(ensured).toMatchObject({ created: true, task: { id: 6 } })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not reuse an assigned same-named ICMP task when the ladder asks for TCP', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = [{
      id: 55,
      name: '北京电信',
      clients: [source.uuid],
      type: 'icmp',
      target: probe.landmarkAddress,
      interval: 30,
    }]
    let added: AdminPingTask | undefined
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        added = request.params
        tasks.push({ ...request.params!, id: 56 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe, {
        hopProbe: { type: 'tcp', port: 53 },
        taskName: '北京电信',
      })
      expect(added).toMatchObject({ name: '北京电信', type: 'tcp', target: `${probe.dnsAddress}:53` })
      expect(ensured).toMatchObject({ created: true, task: { id: 56 } })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reuses an already created same-probe entry task instead of adding a duplicate', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = [{
      id: 56,
      name: '北京电信',
      clients: [source.uuid],
      type: 'tcp',
      target: `${probe.dnsAddress}:53`,
      interval: 30,
    }]
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const created = await createTopologyEntryProbeTask(source, probe, { type: 'tcp', port: 53 }, { taskName: '北京电信' })
      expect(created).toMatchObject({ created: false, task: { id: 56, name: '北京电信', type: 'tcp' } })
      expect(addCalls).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('creates a new ICMP task named after the taskFilter, targeting the landmark address', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        tasks.push({ ...request.params!, id: 11 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe)
      expect(ensured).toMatchObject({
        created: true,
        task: { name: '北京电信', type: 'icmp', target: probe.landmarkAddress, clients: [source.uuid] },
      })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('matches an existing task by label even when it was named after the taskFilter convention', async () => {
    // 广州的入口标签是「广州电信」，但社区惯用任务名是「广东电信」；反过来，
    // 站长如果直接照界面标签建了「广州电信」，也必须能被认领，不能重复创建。
    const guangzhou = getTopologyProbe('guangzhou-telecom')
    const originalFetch = globalThis.fetch
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: [{ id: 9, name: '广州电信', clients: [source.uuid], type: 'icmp', target: '198.51.100.5', interval: 30 }],
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, guangzhou)
      expect(ensured).toMatchObject({ created: false, task: { id: 9, name: '广州电信' } })
      expect(addCalls).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('creates the task only once under concurrent calls', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    let addCalls = 0
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'admin:addPingTask') {
        addCalls += 1
        tasks.push({ ...request.params!, id: 13 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const [first, second] = await Promise.all([
        ensureTopologyEntryProbeTask(source, probe),
        ensureTopologyEntryProbeTask(source, probe),
      ])
      expect(first.task.name).toBe('北京电信')
      expect(second.task.name).toBe('北京电信')
      expect(addCalls).toBe(1)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refuses a rung the preset has no target for instead of guessing an address', async () => {
    // 入口阶梯只有 ICMP 和 TCP 53；443 在骨干网关上没有意义，宁可报错也不能
    // 拿 ICMP 的地址凑一个 443 任务出来。
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string }
      if (request.method === 'admin:getAllPingTasks')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [] }), { headers: { 'Content-Type': 'application/json' } })
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      await expect(ensureTopologyEntryProbeTask(source, probe, { hopProbe: { type: 'tcp', port: 443 } }))
        .rejects
        .toThrow('没有配置 TCP 443 探测目标')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('creates at the requested ladder rung when a hopProbe is given', async () => {
    const originalFetch = globalThis.fetch
    let addedTask: AdminPingTask | undefined
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: addedTask ? [addedTask] : [] }), { headers: { 'Content-Type': 'application/json' } })
      if (request.method === 'admin:addPingTask') {
        addedTask = { ...request.params!, id: 21 }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const ensured = await ensureTopologyEntryProbeTask(source, probe, { hopProbe: { type: 'tcp', port: 53 } })
      expect(ensured).toMatchObject({
        created: true,
        task: { name: '北京电信', type: 'tcp', target: `${probe.dnsAddress}:53` },
      })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('createTopologyEntryProbeTask', () => {
  const probe = getTopologyProbe('guangzhou-telecom')

  test('creates a TCP replacement named after the bound task, not a generated Transit-entry suffix', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: AdminPingTask }
      if (request.method === 'admin:getAllPingTasks')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
      if (request.method === 'admin:addPingTask') {
        tasks.push({ ...request.params!, id: 31 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const created = await createTopologyEntryProbeTask(source, probe, { type: 'tcp', port: 53 }, { taskName: '广州电信' })
      expect(created).toMatchObject({
        created: true,
        task: {
          name: '广州电信',
          type: 'tcp',
          target: `${probe.dnsAddress}:53`,
          clients: [source.uuid],
        },
      })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
