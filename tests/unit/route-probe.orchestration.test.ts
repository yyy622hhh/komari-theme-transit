import type { ExecTaskDispatch, ExecTaskResult } from '../../src/utils/rpcTypes'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { loadRouteProbeNodeTokens, probeNodeRoutes } from '../../src/services/route-probe.service'
import { formatNodeRouteTag } from '../../src/utils/routeTag'
import { parseRouteTraceOutput } from '../../src/utils/routeTrace'
import { resetSharedRpc } from '../../src/utils/rpc'

// probeNodeRoutes 一直用 force:true 校验登录，所以每个用例都得应付一次 /me 请求，
// 不管测试前有没有预置过 session。loadRouteProbeNodeTokens 用 force:false，
// 预置一个新鲜的已登录 session 就能跳过网络校验。

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

/** 把 sleep() 背后的 setTimeout 变成几乎立即触发，绕开 5 秒轮询间隔的真实等待。 */
function stubInstantTimers(): void {
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
    originalSetTimeout(fn, 0, ...args)) as typeof setTimeout
}

interface BackendFixture {
  authenticated?: boolean
  getNodes?: () => Record<string, { tags?: string, token?: string }>
  companionEnqueueStatus?: number
  companionBatch?: (poll: number) => unknown
  execDispatch?: () => ExecTaskDispatch
  execResults?: (taskId: string, poll: number) => ExecTaskResult[]
  editClient?: (params: Record<string, unknown>) => void
}

function mockBackend(fixture: BackendFixture): () => void {
  let companionPoll = 0
  let execPoll = 0
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()

    if (url.includes('/transit-route-probe/v1/enqueue')) {
      if (fixture.companionEnqueueStatus === 404)
        return new Response('', { status: 404 })
      return new Response(JSON.stringify({ batch_id: 'batch-1', jobs: [] }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/transit-route-probe/v1/status')) {
      companionPoll += 1
      return new Response(JSON.stringify(fixture.companionBatch!(companionPoll)), { headers: { 'Content-Type': 'application/json' } })
    }
    if (!init?.body) {
      return new Response(JSON.stringify(
        fixture.authenticated === false ? { logged_in: false } : { logged_in: true, username: 'admin' },
      ))
    }

    const request = JSON.parse(String(init.body)) as { id: number, method: string, params?: Record<string, unknown> }
    if (request.method === 'common:getNodes') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: fixture.getNodes?.() ?? {} }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (request.method === 'admin:exec') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: fixture.execDispatch!() }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (request.method === 'admin:getTaskResultsByTaskId') {
      execPoll += 1
      const taskId = String(request.params?.task_id ?? '')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: fixture.execResults!(taskId, execPoll) }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (request.method === 'admin:editClient') {
      fixture.editClient?.(request.params!)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }), { headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`Unexpected RPC method: ${request.method}`)
  }) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  resetSharedRpc()
  setAuthSessionFromLogin(false)
})

function candidates(...names: string[]) {
  return names.map(name => ({ uuid: name, name }))
}

const REAL_TRACE_OUTPUT = `__TRANSIT_ROUTE_CT__
traceroute to 219.141.140.10 (219.141.140.10), 30 hops max, 60 byte packets
 1  10.0.0.1  0.512 ms
 2  *
 3  59.43.130.1  120.113 ms
 4  59.43.82.2  130.402 ms
 5  202.97.94.1  140.221 ms
 6  219.141.140.10  142.010 ms
__TRANSIT_ROUTE_CU__
traceroute to 202.106.195.68 (202.106.195.68), 30 hops max, 60 byte packets
 1  10.0.0.1  0.480 ms
 2  219.158.16.1  150.002 ms
 3  219.158.3.65  152.114 ms
 4  202.106.195.68  155.003 ms
__TRANSIT_ROUTE_CM__
 1  10.0.0.1  0.470 ms
 2  223.120.140.1  160.008 ms
 3  221.183.55.1  165.221 ms
 4  221.179.155.161  168.114 ms
`

describe('probeNodeRoutes 顶层门禁', () => {
  test('没有候选节点时直接返回 null，不做登录校验', async () => {
    const result = await probeNodeRoutes([], 'beijing')
    expect(result).toBeNull()
  })

  test('登录状态过期时拒绝下发', async () => {
    const restore = mockBackend({ authenticated: false })
    try {
      await expect(probeNodeRoutes(candidates('n1'), 'beijing')).rejects.toThrow('登录状态已过期')
    }
    finally {
      restore()
    }
  })
})

describe('probeNodeRoutes：节点助手路径', () => {
  test('两台节点在第一次轮询就全部拿到结果：一台成功写回，一台报告未装 traceroute', async () => {
    const routeTag = formatNodeRouteTag(parseRouteTraceOutput(REAL_TRACE_OUTPUT), Date.now())
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [
          { client: 'ok', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() },
          { client: 'no-tr', city: 'beijing', status: 'failed', tag: null, error: 'no-traceroute', attempts: 1, helper_seen_at: Date.now() },
        ],
      }),
      getNodes: () => ({
        'ok': { tags: '香港<blue>' },
        'no-tr': { tags: '' },
      }),
      editClient: (params) => {
        expect(params.uuid).toBe('ok')
        expect(String(params.tags)).toContain(routeTag)
        expect(String(params.tags)).toContain('香港<blue>')
      },
    })
    try {
      const summary = await probeNodeRoutes(candidates('ok', 'no-tr'), 'beijing')
      expect(summary?.taskId).toBe('companion:batch-1')
      const outcomes = new Map(summary?.outcomes.map(outcome => [outcome.uuid, outcome]))
      expect(outcomes.get('ok')?.status).toBe('updated')
      expect(outcomes.get('no-tr')?.status).toBe('no-traceroute')
    }
    finally {
      restore()
    }
  })

  test('伴生插件回传过期标签时判为写回失败，而不是当作正常更新', async () => {
    const staleTag = `transit-route:ct=4134.4134@${Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000)}`
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [{ client: 'stale', city: 'beijing', status: 'completed', tag: staleTag, error: null, attempts: 1, helper_seen_at: Date.now() }],
      }),
      getNodes: () => ({ stale: { tags: '' } }),
    })
    try {
      const summary = await probeNodeRoutes(candidates('stale'), 'beijing')
      expect(summary?.outcomes[0]?.status).toBe('failed')
      expect(summary?.outcomes[0]?.detail).toContain('过期')
    }
    finally {
      restore()
    }
  })
})

describe('probeNodeRoutes：伴生插件不可用时回退到远程执行', () => {
  test('插件 404 时改走 admin:exec，成功探测后解析回程标签并写回', async () => {
    stubInstantTimers()
    let dispatchedTaskId = ''
    const restore = mockBackend({
      companionEnqueueStatus: 404,
      execDispatch: () => {
        dispatchedTaskId = 'exec-task-1'
        return { task_id: dispatchedTaskId, clients: ['relay'], queued_clients: null }
      },
      execResults: (taskId, poll) => {
        if (taskId !== dispatchedTaskId || poll < 1)
          return []
        return [{ client: 'relay', result: REAL_TRACE_OUTPUT, exit_code: 0, finished_at: new Date().toISOString(), created_at: new Date().toISOString() }]
      },
      getNodes: () => ({ relay: { tags: '' } }),
      editClient: (params) => {
        expect(params.uuid).toBe('relay')
        expect(String(params.tags)).toContain('transit-route:')
      },
    })
    try {
      const summary = await probeNodeRoutes(candidates('relay'), 'beijing')
      expect(summary?.taskId).toBe('exec-task-1')
      expect(summary?.outcomes[0]?.status).toBe('updated')
    }
    finally {
      restore()
    }
  }, 5000)

  test('节点关闭了远程控制时给出明确原因，而不是笼统的失败', async () => {
    stubInstantTimers()
    const restore = mockBackend({
      companionEnqueueStatus: 404,
      execDispatch: () => ({ task_id: 'exec-task-2', clients: ['relay'], queued_clients: null }),
      execResults: () => [{ client: 'relay', result: 'Remote control is disabled.', exit_code: 1, finished_at: new Date().toISOString(), created_at: new Date().toISOString() }],
    })
    try {
      const summary = await probeNodeRoutes(candidates('relay'), 'beijing')
      expect(summary?.outcomes[0]?.status).toBe('remote-disabled')
    }
    finally {
      restore()
    }
  }, 5000)
})

describe('loadRouteProbeNodeTokens', () => {
  test('会话新鲜时不再重新校验登录，直接按 uuid 过滤 token', async () => {
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
    const restore = mockBackend({
      getNodes: () => ({
        a: { token: 'token-a' },
        b: { token: 'token-b' },
      }),
    })
    try {
      const tokens = await loadRouteProbeNodeTokens(['a', 'ghost'])
      expect(tokens).toEqual({ a: 'token-a' })
    }
    finally {
      restore()
    }
  })

  test('未登录时拒绝返回 token', async () => {
    const restore = mockBackend({ authenticated: false })
    try {
      await expect(loadRouteProbeNodeTokens(['a'])).rejects.toThrow('登录状态已过期')
    }
    finally {
      restore()
    }
  })

  test('空的 uuid 列表直接返回空对象，不发请求', async () => {
    const tokens = await loadRouteProbeNodeTokens([])
    expect(tokens).toEqual({})
  })
})
