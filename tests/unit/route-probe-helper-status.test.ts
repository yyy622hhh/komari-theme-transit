import type { NodeData } from '../../src/stores/nodes'
import { createRequire } from 'node:module'
import { afterEach, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useRouteProbeSetupWizard } from '../../src/composables/useRouteProbeSetupWizard'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { getCompanionRouteProbeRoster } from '../../src/services/route-probe-companion.service'
import { probeNodeRoutes } from '../../src/services/route-probe.service'
import { resetSharedRpc } from '../../src/utils/rpc'

const require = createRequire(import.meta.url)
const { RouteProbeCoordinator } = require('../../companion/transit-route-probe/protocol.cjs')

const originalNow = Date.now
const originalTimeout = globalThis.setTimeout
const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalVersion = Object.getOwnPropertyDescriptor(globalThis, '__BUILD_VERSION__')
afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalTimeout
  Date.now = originalNow
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  for (const [key, descriptor] of [['localStorage', originalStorage], ['__BUILD_VERSION__', originalVersion]] as const) {
    if (descriptor)
      Object.defineProperty(globalThis, key, descriptor)
    else
      Reflect.deleteProperty(globalThis, key)
  }
})

for (const seenPreviously of [false, true]) {
  test(`never-leased task expiry is helper-offline, not a failed probe (prior heartbeat: ${seenPreviously})`, async () => {
    let now = originalNow()
    const started = now
    let sequence = 0
    const coordinator = new RouteProbeCoordinator({ now: () => now, randomId: () => `qa${String(++sequence).padStart(16, '0')}` })
    if (seenPreviously)
      coordinator.poll('no-helper')
    Date.now = () => now
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 5000) {
        now += ms
        return originalTimeout(fn, 0, ...args)
      }
      return originalTimeout(fn, ms, ...args)
    }) as typeof setTimeout
    let batchId = ''
    globalThis.fetch = (async (url, init) => {
      const target = String(url)
      if (target.endsWith('/api/me'))
        return Response.json({ logged_in: true, username: 'admin' })
      if (target.endsWith('/enqueue')) {
        const args = JSON.parse(String(init?.body))
        const result = coordinator.enqueue(args.clients, args.city)
        batchId = result.batch_id
        return Response.json(result, { status: 202 })
      }
      if (target.includes('/status?'))
        return Response.json(coordinator.status(batchId))
      const request = JSON.parse(String(init?.body))
      if (request.method === 'common:getNodes')
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { 'no-helper': { tags: '' } } })
      throw new Error(`Unexpected ${target}`)
    }) as typeof fetch
    const result = await probeNodeRoutes([{ uuid: 'no-helper', name: 'No helper installed' }], 'beijing', { trigger: 'manual', persistence: { theme: 'Transit' } })
    expect(result?.outcomes[0]?.status).toBe('helper-offline')
    expect(result?.outcomes[0]?.detail).toContain('未领取任务')
    expect(now - started).toBe(605000)
  })
}

test('an old helper executing a valid lease remains busy until completion or lease expiry', async () => {
  let now = originalNow()
  let sequence = 0
  const coordinator = new RouteProbeCoordinator({ now: () => now, randomId: () => `qa${String(++sequence).padStart(16, '0')}` })
  coordinator.enqueue(['busy-helper'], 'beijing')
  const job = coordinator.poll('busy-helper')
  now += 41000
  Date.now = () => now
  Object.defineProperty(globalThis, '__BUILD_VERSION__', { configurable: true, value: '1.4.1' })
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } })
  globalThis.fetch = (async (url, init) => {
    const target = String(url)
    if (target.endsWith('/api/me'))
      return Response.json({ logged_in: true, username: 'admin' })
    if (target.endsWith('/health'))
      return Response.json({ ok: true, protocol: 1, version: '1.4.1' })
    if (target.includes('/roster?'))
      return Response.json(coordinator.roster(['busy-helper']))
    const request = JSON.parse(String(init?.body))
    if (request.method === 'common:getNodes')
      return Response.json({ jsonrpc: '2.0', id: request.id, result: {} })
    throw new Error(`Unexpected ${target}`)
  }) as typeof fetch
  const pinia = createPinia()
  setActivePinia(pinia)
  const scope = effectScope()
  try {
    const wizard = scope.run(() => useRouteProbeSetupWizard([{ uuid: 'busy-helper', name: 'Busy helper', online: true, region: 'US' }] as NodeData[]))!
    await wizard.runCheck()
    expect(wizard.checkError.value).toBe('')
    expect(wizard.onlineHelperCount.value).toBe(1)
    expect(wizard.missingHelperNodes.value).toHaveLength(0)
    expect(wizard.eligibleNodes.value[0]).toMatchObject({ helperBusy: true, helperVersionMatches: null })
    // Busy status is derived from persisted leases, not a new transient heartbeat field.
    const restored = new RouteProbeCoordinator({ now: () => now, randomId: () => 'restored-test' })
    restored.importState(coordinator.exportState())
    expect(restored.roster(['busy-helper'])).toEqual(coordinator.roster(['busy-helper']))
    restored.submit('busy-helper', { job_id: job.id, error: 'probe-failed' })
    expect(restored.roster(['busy-helper']).clients[0].active_job_until).toBeNull()
    now += 140000
    await wizard.runCheck()
    expect(wizard.onlineHelperCount.value).toBe(0)
    expect(wizard.eligibleNodes.value[0]?.helperBusy).toBeFalse()
    coordinator.submit('busy-helper', { job_id: job.id, error: 'probe-failed' })
    coordinator.poll('busy-helper')
    await wizard.runCheck()
    expect(wizard.onlineHelperCount.value).toBe(1)
    expect(wizard.eligibleNodes.value[0]?.helperBusy).toBeFalse()
  }
  finally {
    scope.stop()
    disposePinia(pinia)
  }
})

test('missing-helper token fetch is skipped once the set has not changed since the last check', async () => {
  const now = originalNow()
  const coordinator = new RouteProbeCoordinator({ now: () => now, randomId: () => 'qa' })
  Date.now = () => now
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } })
  let getNodesCalls = 0
  globalThis.fetch = (async (url, init) => {
    const target = String(url)
    if (target.endsWith('/api/me'))
      return Response.json({ logged_in: true, username: 'admin' })
    if (target.endsWith('/health'))
      return Response.json({ ok: true, protocol: 1, version: '1.4.1' })
    if (target.includes('/roster?'))
      return Response.json(coordinator.roster(['no-helper']))
    const request = JSON.parse(String(init?.body))
    if (request.method === 'common:getNodes') {
      getNodesCalls += 1
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { 'no-helper': { token: 'secret-token' } } })
    }
    throw new Error(`Unexpected ${target}`)
  }) as typeof fetch
  const pinia = createPinia()
  setActivePinia(pinia)
  const scope = effectScope()
  try {
    const wizard = scope.run(() => useRouteProbeSetupWizard([{ uuid: 'no-helper', name: 'No helper', online: true, region: 'US' }] as NodeData[]))!
    await wizard.runCheck()
    expect(wizard.missingHelperNodes.value).toHaveLength(1)
    expect(wizard.tokenFor('no-helper')).toBe('secret-token')
    expect(getNodesCalls).toBe(1)
    // 助手依旧缺失、集合没变——重新检查不该再把全节点表连同 token 拉一遍。
    await wizard.runCheck()
    expect(getNodesCalls).toBe(1)
  }
  finally {
    scope.stop()
    disposePinia(pinia)
  }
})

test('older plugins without the optional lease field still parse', async () => {
  globalThis.fetch = (async () => Response.json({ clients: [{ client: 'old-helper', helper_seen_at: originalNow() }] })) as typeof fetch
  expect(await getCompanionRouteProbeRoster(['old-helper'])).toMatchObject([{ client: 'old-helper', active_job_until: null }])
})

test('invalid lease timestamps cannot keep a helper permanently busy', async () => {
  globalThis.fetch = (async () => Response.json({ clients: [{ client: 'old-helper', helper_seen_at: null, active_job_until: 'forever' }] })) as typeof fetch
  await expect(getCompanionRouteProbeRoster(['old-helper'])).rejects.toThrow('无效的花名册')
})
