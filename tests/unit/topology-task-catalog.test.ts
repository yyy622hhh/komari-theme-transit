import type { AdminPingTask } from '../../src/services/ping-task.service'
import type { NodeData } from '../../src/stores/nodes'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useTopologyTaskCatalog } from '../../src/composables/useTopologyTaskCatalog'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { invalidateAdminPingTasksCache } from '../../src/services/ping-task.service'
import { resetSharedRpc } from '../../src/utils/rpc'

const relay: NodeData = { uuid: 'relay-uuid', name: 'Relay-JP' } as NodeData
const nodes = [relay]
const noAmbiguity = () => false

interface MockCallCounter { list: number }

function mockAdminTaskList(tasks: AdminPingTask[], options: { failWith?: number } = {}): { restore: () => void, calls: MockCallCounter } {
  const originalFetch = globalThis.fetch
  const calls: MockCallCounter = { list: 0 }
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body)
      return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
    const request = JSON.parse(String(init.body)) as { id: number, method: string }
    if (request.method !== 'admin:getAllPingTasks')
      throw new Error(`Unexpected RPC method: ${request.method}`)
    calls.list += 1
    if (options.failWith)
      return new Response('', { status: options.failWith })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: tasks }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return {
    restore: () => { globalThis.fetch = originalFetch },
    calls,
  }
}

afterEach(() => {
  mock.restore()
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  invalidateAdminPingTasksCache()
})

describe('useTopologyTaskCatalog', () => {
  test('loads and stores the task list for a resolved node', async () => {
    const { restore } = mockAdminTaskList([
      { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [relay.uuid], type: 'icmp', target: '203.0.113.20', interval: 30 },
    ])
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      const result = await catalog.loadTasks(relay.name)
      expect(result).toEqual({ tasks: ['Transit-Relay-JP-to-Exit-SG'], error: '' })
      expect(catalog.taskOptions.value[relay.uuid]).toEqual(['Transit-Relay-JP-to-Exit-SG'])
      expect(catalog.taskLoaded.value[relay.uuid]).toBe(true)
      expect(catalog.taskErrors.value[relay.uuid]).toBe('')
    }
    finally {
      restore()
    }
  })

  test('reports a duplicate-name error without touching the network', async () => {
    const { restore, calls } = mockAdminTaskList([])
    try {
      const catalog = useTopologyTaskCatalog(nodes, name => name === 'Ambiguous-Relay')
      const result = await catalog.loadTasks('Ambiguous-Relay')
      expect(result).toEqual({ tasks: [], error: '节点名称重复，无法唯一读取 Ping 任务。' })
      expect(calls.list).toBe(0)
    }
    finally {
      restore()
    }
  })

  test('is a silent no-op for an unresolved, non-ambiguous name', async () => {
    const { restore, calls } = mockAdminTaskList([])
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      const result = await catalog.loadTasks('Unknown-Relay')
      expect(result).toEqual({ tasks: [], error: '' })
      expect(calls.list).toBe(0)
    }
    finally {
      restore()
    }
  })

  test('dedupes concurrent loads for the same node into a single request', async () => {
    const { restore, calls } = mockAdminTaskList([
      { id: 1, name: 'Transit-Relay-JP-to-Exit-SG', clients: [relay.uuid], type: 'icmp', target: '203.0.113.20', interval: 30 },
    ])
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      const [first, second] = await Promise.all([catalog.loadTasks(relay.name), catalog.loadTasks(relay.name)])
      expect(first).toEqual(second)
      expect(calls.list).toBe(1)
    }
    finally {
      restore()
    }
  })

  test('passes through a session-expiry message verbatim', async () => {
    const { restore } = mockAdminTaskList([], { failWith: 403 })
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      const result = await catalog.loadTasks(relay.name)
      expect(result.error).toContain('登录状态已过期')
      expect(catalog.taskErrors.value[relay.uuid]).toBe(result.error)
      expect(catalog.taskLoaded.value[relay.uuid]).toBe(false)
    }
    finally {
      restore()
    }
  })

  test('maps a non-auth failure to the generic retry message', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return new Response(JSON.stringify({ logged_in: true, username: 'admin' }))
      throw new TypeError('network down')
    }) as typeof fetch
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      const result = await catalog.loadTasks(relay.name)
      expect(result.error).toBe('无法读取 Ping 任务，请稍后重试。')
      expect(catalog.taskErrors.value[relay.uuid]).toBe('无法读取 Ping 任务，请稍后重试。')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('calls onRequestSettled exactly once per request, on both success and failure', async () => {
    const successList = mockAdminTaskList([
      { id: 1, name: 'ok', clients: [relay.uuid], type: 'icmp', target: '203.0.113.20', interval: 30 },
    ])
    let settledCount = 0
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity, () => {
        settledCount += 1
      })
      await catalog.loadTasks(relay.name)
      expect(settledCount).toBe(1)
    }
    finally {
      successList.restore()
    }

    const failing = mockAdminTaskList([], { failWith: 500 })
    try {
      settledCount = 0
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity, () => {
        settledCount += 1
      })
      await catalog.loadTasks(relay.name)
      expect(settledCount).toBe(1)
    }
    finally {
      failing.restore()
    }
  })

  test('does not call onRequestSettled for names that never reach the network', async () => {
    let settledCount = 0
    const catalog = useTopologyTaskCatalog(nodes, name => name === 'Ambiguous-Relay', () => {
      settledCount += 1
    })
    await catalog.loadTasks('Ambiguous-Relay')
    await catalog.loadTasks('Unknown-Relay')
    expect(settledCount).toBe(0)
  })

  test('rememberTask adds a task without duplicating an existing entry', () => {
    const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
    catalog.rememberTask(relay.uuid, 'Transit-Relay-JP-to-Exit-SG')
    catalog.rememberTask(relay.uuid, 'Transit-Relay-JP-to-Exit-SG')
    catalog.rememberTask(relay.uuid, 'Transit-Relay-JP-to-Exit-JP')
    expect(catalog.taskOptions.value[relay.uuid]).toEqual(['Transit-Relay-JP-to-Exit-SG', 'Transit-Relay-JP-to-Exit-JP'])
    expect(catalog.taskLoaded.value[relay.uuid]).toBe(true)
  })

  test('rememberTask is a no-op for an empty source or task name', () => {
    const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
    catalog.rememberTask('', 'some-task')
    catalog.rememberTask(relay.uuid, '')
    expect(catalog.taskOptions.value).toEqual({})
  })

  test('reset clears every loaded/errored/pending state', async () => {
    const { restore } = mockAdminTaskList([
      { id: 1, name: 'ok', clients: [relay.uuid], type: 'icmp', target: '203.0.113.20', interval: 30 },
    ])
    try {
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity)
      await catalog.loadTasks(relay.name)
      expect(catalog.taskOptions.value[relay.uuid]).toBeDefined()

      catalog.reset()
      expect(catalog.taskOptions.value).toEqual({})
      expect(catalog.taskErrors.value).toEqual({})
      expect(catalog.taskLoaded.value).toEqual({})
    }
    finally {
      restore()
    }
  })

  test('reset isolates a late response from the previous dialog session', async () => {
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
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: [{ id: 2, name: 'new-session', clients: [relay.uuid], type: 'icmp', target: '203.0.113.21', interval: 30 }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      let settledCount = 0
      const catalog = useTopologyTaskCatalog(nodes, noAmbiguity, () => {
        settledCount += 1
      })
      const oldLoad = catalog.loadTasks(relay.name)
      await oldStarted
      catalog.reset()
      const newLoad = await catalog.loadTasks(relay.name)
      releaseOld(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: [{ id: 1, name: 'old-session', clients: [relay.uuid], type: 'icmp', target: '203.0.113.20', interval: 30 }],
      }), { headers: { 'Content-Type': 'application/json' } }))
      await oldLoad

      expect(newLoad.tasks).toEqual(['new-session'])
      expect(catalog.taskOptions.value[relay.uuid]).toEqual(['new-session'])
      expect(settledCount).toBe(1)
      expect(listCalls).toBe(2)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
