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
//
// 保存路径统一走 `saveRouteProbeResults`（写 Transit 主题数据），这里整体
// mock 掉那一层：真正的 HTTP 读改写流程已经由 tests/visual 覆盖，这里只关心
// 编排本身——一次轮询里的多台节点是否合并成一次保存、保存失败如何归因、
// 没有旧标签时是否真的跳过清理这一趟额外请求。
const fakeRouteResults = {
  saved: {} as Record<string, string>,
  saveCalls: [] as Array<{ theme: string, results: Record<string, string> }>,
  saveError: null as string | null,
}

function resetFakeRouteResults(): void {
  fakeRouteResults.saved = {}
  fakeRouteResults.saveCalls = []
  fakeRouteResults.saveError = null
}

mock.module('../../src/services/route-probe-results.service', () => ({
  saveRouteProbeResults: async (options: { theme: string, results: Record<string, string>, activeNodeIds?: readonly string[] }) => {
    if (fakeRouteResults.saveError)
      throw new Error(fakeRouteResults.saveError)
    fakeRouteResults.saveCalls.push({ theme: options.theme, results: { ...options.results } })
    // 贴近真实 mergeRouteProbeResults 的行为：不在白名单里的 uuid 直接被滤掉，
    // 不进入保存后返回的结果集——用来验证「探测期间节点掉出列表」这条路径。
    const allowed = options.activeNodeIds ? new Set(options.activeNodeIds.map(id => id.trim())) : null
    for (const [uuid, tag] of Object.entries(options.results)) {
      if (!allowed || allowed.has(uuid))
        fakeRouteResults.saved[uuid] = tag
    }
    return { ...fakeRouteResults.saved }
  },
  // 这几个用例都不给节点预置 `transit-route:` 遗留标签，批量写回按设计会跳过
  // 清理这一步（见 route-probe.service.ts 的 writeRouteTagsBatch），所以这里
  // 不需要还原真实清理逻辑——真被调用说明「跳过清理」的判断本身坏了。
  cleanupPersistedLegacyRouteTag: async () => {
    throw new Error('测试没有预置遗留标签，不应该走到清理这一步')
  },
}))

function persistence(theme = 'Transit', activeNodeIds?: readonly string[]) {
  return activeNodeIds ? { theme, activeNodeIds } : { theme }
}

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalNow = Date.now

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
  companionStatusStatus?: (poll: number) => number | null
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
      const status = fixture.companionStatusStatus?.(companionPoll) ?? null
      if (status !== null)
        return new Response('', { status })
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
  Date.now = originalNow
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  resetFakeRouteResults()
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
    const result = await probeNodeRoutes([], 'beijing', { trigger: 'manual', persistence: persistence() })
    expect(result).toBeNull()
  })

  test('登录状态过期时拒绝下发', async () => {
    const restore = mockBackend({ authenticated: false })
    try {
      await expect(probeNodeRoutes(candidates('n1'), 'beijing', { trigger: 'manual', persistence: persistence() })).rejects.toThrow('登录状态已过期')
    }
    finally {
      restore()
    }
  })
})

describe('probeNodeRoutes：节点助手路径', () => {
  for (const completeAt of [160_000, 520_000]) {
    test(`waits for a valid companion result after ${completeAt / 1000}s including queue/backoff and upload`, async () => {
      const started = originalNow()
      let elapsed = 0
      Date.now = () => started + elapsed
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms === 5000) {
          elapsed += ms
          return originalSetTimeout(fn, 0, ...args)
        }
        return originalSetTimeout(fn, ms, ...args)
      }) as typeof setTimeout
      const restore = mockBackend({
        companionBatch: () => ({ batch_id: 'batch-1', jobs: [{
          client: 'slow',
          city: 'beijing',
          status: elapsed >= completeAt ? 'completed' : elapsed < completeAt - 160_000 ? 'queued' : 'running',
          tag: elapsed >= completeAt ? `transit-route:ct=4134,cu=4837,cm=9808@${Math.floor(Date.now() / 1000)}` : null,
          error: null,
          attempts: 1,
          helper_seen_at: Date.now(),
        }] }),
        getNodes: () => ({ slow: { tags: '' } }),
      })
      try {
        expect((await probeNodeRoutes(candidates('slow'), 'beijing', { trigger: 'manual', persistence: persistence() }))?.outcomes[0]?.status).toBe('updated')
        // 没有遗留标签，批量写回应该跳过清理这一趟额外请求。
        expect(fakeRouteResults.saved.slow).toContain('transit-route:')
        expect(elapsed).toBe(completeAt)
      }
      finally { restore() }
    })
  }
  test('a companion that never finishes still has a bounded wait', async () => {
    const started = originalNow()
    let elapsed = 0
    Date.now = () => started + elapsed
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 5000) {
        elapsed += ms
        return originalSetTimeout(fn, 0, ...args)
      }
      return originalSetTimeout(fn, ms, ...args)
    }) as typeof setTimeout
    const restore = mockBackend({ companionBatch: () => ({ batch_id: 'batch-1', jobs: [{ client: 'stuck', city: 'beijing', status: 'running', tag: null, error: null, attempts: 1, helper_seen_at: Date.now() }] }) })
    try {
      expect((await probeNodeRoutes(candidates('stuck'), 'beijing', { trigger: 'manual', persistence: persistence() }))?.outcomes[0]?.status).toBe('timeout')
      expect(elapsed).toBe(630_000)
    }
    finally { restore() }
  })
  test('两台节点在第一次轮询就全部拿到结果：合并成一次保存，一台成功写回，一台报告未装 traceroute', async () => {
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
    })
    try {
      const summary = await probeNodeRoutes(candidates('ok', 'no-tr'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.taskId).toBe('companion:batch-1')
      const outcomes = new Map(summary?.outcomes.map(outcome => [outcome.uuid, outcome]))
      expect(outcomes.get('ok')?.status).toBe('updated')
      expect(outcomes.get('no-tr')?.status).toBe('no-traceroute')
      // 一轮里唯一成功的节点合并进同一次保存调用，不是逐台各存一次。
      expect(fakeRouteResults.saveCalls).toHaveLength(1)
      expect(fakeRouteResults.saveCalls[0]!.results).toEqual({ ok: routeTag })
    }
    finally {
      restore()
    }
  })

  test('两台节点在同一轮都成功时，只合并成一次保存请求', async () => {
    const routeTag = formatNodeRouteTag(parseRouteTraceOutput(REAL_TRACE_OUTPUT), Date.now())
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [
          { client: 'a', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() },
          { client: 'b', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() },
        ],
      }),
      getNodes: () => ({ a: { tags: '' }, b: { tags: '' } }),
    })
    try {
      const summary = await probeNodeRoutes(candidates('a', 'b'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.outcomes.every(outcome => outcome.status === 'updated')).toBe(true)
      expect(fakeRouteResults.saveCalls).toHaveLength(1)
      expect(fakeRouteResults.saveCalls[0]!.results).toEqual({ a: routeTag, b: routeTag })
    }
    finally {
      restore()
    }
  })

  test('插件侧的 invalid-city/internal-error 不归因为节点助手未连接', async () => {
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [
          { client: 'bad-city', city: 'beijing', status: 'failed', tag: null, error: 'invalid-city', attempts: 0, helper_seen_at: Date.now() },
          { client: 'plugin-bug', city: 'beijing', status: 'failed', tag: null, error: 'internal-error', attempts: 0, helper_seen_at: Date.now() },
        ],
      }),
      getNodes: () => ({ 'bad-city': { tags: '' }, 'plugin-bug': { tags: '' } }),
    })
    try {
      const summary = await probeNodeRoutes(candidates('bad-city', 'plugin-bug'), 'beijing', { trigger: 'manual', persistence: persistence() })
      const outcomes = new Map(summary?.outcomes.map(outcome => [outcome.uuid, outcome]))
      expect(outcomes.get('bad-city')?.status).toBe('failed')
      expect(outcomes.get('bad-city')?.detail).toContain('城市')
      expect(outcomes.get('plugin-bug')?.status).toBe('failed')
      expect(outcomes.get('plugin-bug')?.detail).toContain('内部错误')
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
      const summary = await probeNodeRoutes(candidates('stale'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.outcomes[0]?.status).toBe('failed')
      expect(summary?.outcomes[0]?.detail).toContain('过期')
      expect(fakeRouteResults.saveCalls).toHaveLength(0)
    }
    finally {
      restore()
    }
  })

  test('保存到主题数据失败时，批次内每台都报告失败并各自留痕，而不是静默写回旧标签', async () => {
    const routeTag = formatNodeRouteTag(parseRouteTraceOutput(REAL_TRACE_OUTPUT), Date.now())
    fakeRouteResults.saveError = '模拟保存失败'
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [{ client: 'ok', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() }],
      }),
      getNodes: () => ({ ok: { tags: '' } }),
    })
    try {
      const summary = await probeNodeRoutes(candidates('ok'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.outcomes[0]?.status).toBe('failed')
      expect(summary?.outcomes[0]?.detail).toContain('模拟保存失败')
    }
    finally {
      restore()
    }
  })

  test('节点在等待结果期间掉出白名单时，报告的原因是节点已不在列表，而不是笼统的服务器未保留', async () => {
    const routeTag = formatNodeRouteTag(parseRouteTraceOutput(REAL_TRACE_OUTPUT), Date.now())
    const restore = mockBackend({
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [{ client: 'gone', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() }],
      }),
      getNodes: () => ({ gone: { tags: '' } }),
    })
    try {
      // activeNodeIds 不包含 'gone'，模拟探测期间该节点已被隐藏/删除。
      const summary = await probeNodeRoutes(candidates('gone'), 'beijing', { trigger: 'manual', persistence: persistence('Transit', ['other-node']) })
      expect(summary?.outcomes[0]?.status).toBe('failed')
      expect(summary?.outcomes[0]?.detail).toContain('已不在当前节点列表中')
    }
    finally {
      restore()
    }
  })

  test('单次状态轮询失败不会整批判死，下一轮恢复正常就能继续拿到结果', async () => {
    const routeTag = formatNodeRouteTag(parseRouteTraceOutput(REAL_TRACE_OUTPUT), Date.now())
    stubInstantTimers()
    let calls = 0
    const restore = mockBackend({
      companionStatusStatus: () => {
        calls += 1
        return calls === 1 ? 500 : null
      },
      companionBatch: () => ({
        batch_id: 'batch-1',
        jobs: [{ client: 'ok', city: 'beijing', status: 'completed', tag: routeTag, error: null, attempts: 1, helper_seen_at: Date.now() }],
      }),
      getNodes: () => ({ ok: { tags: '' } }),
    })
    try {
      const summary = await probeNodeRoutes(candidates('ok'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.outcomes[0]?.status).toBe('updated')
      expect(calls).toBeGreaterThan(1)
    }
    finally {
      restore()
    }
  }, 5000)

  test('已接单批次的状态查询明确 404 时立即放弃，不重试也不回退到远程执行', async () => {
    stubInstantTimers()
    const restore = mockBackend({
      companionStatusStatus: () => 404,
      getNodes: () => ({ ok: { tags: '' } }),
    })
    try {
      await expect(probeNodeRoutes(candidates('ok'), 'beijing', { trigger: 'manual', persistence: persistence() })).rejects.toThrow()
      expect(fakeRouteResults.saveCalls).toHaveLength(0)
    }
    finally {
      restore()
    }
  }, 5000)
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
    })
    try {
      const summary = await probeNodeRoutes(candidates('relay'), 'beijing', { trigger: 'manual', persistence: persistence() })
      expect(summary?.taskId).toBe('exec-task-1')
      expect(summary?.outcomes[0]?.status).toBe('updated')
      expect(fakeRouteResults.saved.relay).toContain('transit-route:')
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
      const summary = await probeNodeRoutes(candidates('relay'), 'beijing', { trigger: 'manual', persistence: persistence() })
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
