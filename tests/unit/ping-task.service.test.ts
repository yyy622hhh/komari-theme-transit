import type { AdminPingTask } from '../../src/services/ping-task.service'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { isAuthenticated, setAuthSessionFromLogin } from '../../src/services/auth.service'
import { buildTopologyHopTarget, ensureTopologyPingTask, findTopologyPingTask, findTopologyPingTaskByName, isPingTaskAssignedToSource, loadAdminPingTaskNamesForNode, pingTaskTargetHost, pingTaskTargetPort, planTopologyPingTask, topologyHopTaskName, topologyPingTargets } from '../../src/services/ping-task.service'
import { resetSharedRpc } from '../../src/utils/rpc'

const source = { uuid: 'relay-uuid', name: 'Relay-JP', ipv4: '192.0.2.10' }
const target = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20', ipv6: '2001:db8::20' }

afterEach(() => {
  mock.restore()
  resetSharedRpc()
  setAuthSessionFromLogin(false)
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
    expect(findTopologyPingTask(tasks, source.uuid, target)?.name).toBe('right')
  })

  test('does not reuse a TCP or HTTP check as the topology hop', () => {
    const tasks: AdminPingTask[] = [
      { id: 2, name: 'ssh-check', clients: [source.uuid], type: 'tcp', target: `${target.ipv4}:22`, interval: 30 },
      { id: 3, name: 'health-check', clients: [source.uuid], type: 'http', target: `http://${target.ipv4}/health`, interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target)).toBeUndefined()
  })

  test('does not reuse a duplicate task name on the same source', () => {
    const tasks: AdminPingTask[] = [
      { id: 1, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: target.ipv4, interval: 30 },
      { id: 2, name: 'duplicate', clients: [source.uuid], type: 'icmp', target: '203.0.113.99', interval: 30 },
    ]
    expect(findTopologyPingTask(tasks, source.uuid, target)).toBeUndefined()
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
    ], source.uuid, target)).toBeUndefined()
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

  test('an aborted waiter does not fail a shared in-flight ensure', async () => {
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
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
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

  test('propagates cancellation to an in-flight Ping task creation', async () => {
    const originalFetch = globalThis.fetch
    const tasks: AdminPingTask[] = []
    let addCalls = 0
    let addAborted = false
    let resolveAddStarted: (() => void) | undefined
    const addStarted = new Promise<void>((resolve) => {
      resolveAddStarted = resolve
    })
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
        resolveAddStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            addAborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    }) as typeof fetch

    try {
      const controller = new AbortController()
      const creating = ensureTopologyPingTask(source, target, { signal: controller.signal })
      await addStarted
      controller.abort()

      await expect(creating).rejects.toMatchObject({ name: 'AbortError' })
      expect(addCalls).toBe(1)
      expect(addAborted).toBe(true)
      expect(tasks).toEqual([])
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
