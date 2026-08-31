import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { expect, test } from 'bun:test'

const pluginFile = resolve('companion/transit-route-probe/script.js')
const pluginRequire = createRequire(pluginFile)
const { RouteProbeCoordinator } = pluginRequire('./protocol.cjs')
const { StorageCheckpoint } = pluginRequire('./storage.cjs')
const { ClientRequestLimiter } = pluginRequire('./request-limits.cjs')
const admin = { type: 'user', roles: ['admin'] }
const agent = { type: 'agent', client_uuid: 'test-client-a' }
const guard = { 'x-transit-route-probe': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
const jsonHeader = { 'content-type': 'application/json' }

/** Actual registered route handlers, coordinator and storage; host identity and filesystem injected. */
function harness() {
  let now = Date.now()
  let writes = 0
  let fault = false
  const logs: string[] = []
  const memory = new Map<string, string>()
  const routes = new Map<string, (req: any, res: any) => void>()
  const fileSystem = {
    existsSync: (file: string) => memory.has(file),
    readFileSync: (file: string) => memory.get(file),
    mkdirSync() {},
    unlinkSync(file: string) { memory.delete(file) },
    writeFileSync(file: string, data: string) {
      writes++
      if (fault)
        throw Object.assign(new Error('private-path secret-token'), { code: 'EACCES' })
      memory.set(file, data)
    },
    renameSync(from: string, to: string) {
      memory.set(to, memory.get(from)!)
      memory.delete(from)
    },
  }
  const context = vm.createContext({
    __storageDir__: '/memory-only',
    TypeError,
    SyntaxError,
    console: { warn: (message: string) => logs.push(message) },
    require: (name: string) => {
      if (name === 'server')
        return { route(method: string, route: string, handler: any) { routes.set(`${method} ${route.split('/').pop()}`, handler) } }
      if (name === 'fs')
        return fileSystem
      if (name === './protocol.cjs')
        return { RouteProbeCoordinator: class extends RouteProbeCoordinator { constructor(options: object) { super({ ...options, now: () => now }) } } }
      if (name === './storage.cjs')
        return { StorageCheckpoint: class extends StorageCheckpoint { constructor(options: object) { super({ ...options, now: () => now }) } } }
      if (name === './request-limits.cjs')
        return { ClientRequestLimiter: class extends ClientRequestLimiter { constructor() { super(() => now) } } }
      return pluginRequire(name)
    },
  })
  vm.runInContext(readFileSync(pluginFile, 'utf8'), context)
  context.load()
  function request(method: string, route: string, identity: unknown, body = '', headers: object = {}) {
    const response = {
      statusCode: 0,
      payload: '',
      headers: {} as Record<string, string>,
      setHeader(key: string, value: string) { this.headers[key] = value },
      end(payload = '') { this.payload = payload },
    }
    routes.get(`${method} ${route}`)!({ method, headers, body, query: {}, context: { principal: identity } }, response)
    return response
  }
  const enqueue = () => request('POST', 'enqueue', admin, JSON.stringify({ clients: [agent.client_uuid], city: 'beijing' }), guard)
  return { request, enqueue, logs, memory, advance: (ms: number) => now += ms, writes: () => writes, fault: (value: boolean) => fault = value }
}

test('registered routes deny guests, wrong principals and missing/cross-origin admin guards', () => {
  const h = harness()
  for (const [method, route] of [['GET', 'health'], ['GET', 'status'], ['GET', 'roster'], ['POST', 'enqueue']]) {
    for (const principal of [null, { type: 'user', roles: [] }, agent])
      expect(h.request(method!, route!, principal, '{}', guard).statusCode).toBe(403)
    expect(h.request(method!, route!, admin, '{}', { ...guard, 'sec-fetch-site': 'cross-site' }).statusCode).toBe(403)
    expect(h.request(method!, route!, admin, '{}').statusCode).toBe(403)
  }
  for (const [method, route] of [['GET', 'poll'], ['POST', 'poll'], ['POST', 'result']]) {
    for (const principal of [null, admin, { type: 'agent' }])
      expect(h.request(method!, route!, principal, '{}', jsonHeader).statusCode).toBe(401)
  }
})

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy GET/form' : 'new POST/JSON'} helpers preserve node identity and result compatibility`, () => {
    const h = harness()
    expect(h.enqueue().statusCode).toBe(202)
    const lease = h.request(legacy ? 'GET' : 'POST', 'poll', agent, legacy ? '' : '{"token":"secret-token","client":"other-client"}', jsonHeader)
    expect(lease.statusCode).toBe(200)
    const id = lease.payload.trim().split('\t')[0]
    const result = { job_id: id, error: 'probe-failed', token: 'secret-token', client: 'other-client' }
    const body = legacy ? new URLSearchParams(result).toString() : JSON.stringify({ ...result, duration_ms: 10 })
    const headers = legacy ? { 'content-type': 'application/x-www-form-urlencoded' } : jsonHeader
    expect(h.request('POST', 'result', { type: 'agent', client_uuid: 'other-client' }, body, headers).statusCode).toBe(403)
    expect(JSON.parse(h.request('POST', 'result', agent, body, headers).payload)).toEqual({ status: 'failed' })
    expect(h.logs.join('\n')).not.toContain('secret-token')
    expect([...h.memory.values()].join('\n')).not.toContain('secret-token')
  })
}

test('replayed completed results cause neither repeated writes nor log flooding and are throttled', () => {
  const h = harness()
  h.enqueue()
  const id = h.request('POST', 'poll', agent, '{}', jsonHeader).payload.trim().split('\t')[0]
  const body = JSON.stringify({ job_id: id, error: 'probe-failed' })
  expect(h.request('POST', 'result', agent, body, jsonHeader).statusCode).toBe(200)
  const before = h.writes()
  const logs = h.logs.length
  let throttled = 0
  for (let index = 0; index < 100; index++) {
    const response = h.request('POST', 'result', agent, body, jsonHeader)
    expect([200, 429]).toContain(response.statusCode)
    if (response.statusCode === 429) {
      throttled++
      expect(Number(response.headers['Retry-After'])).toBeGreaterThan(0)
    }
  }
  expect(throttled).toBeGreaterThan(90)
  expect(h.writes()).toBe(before)
  expect(h.logs).toHaveLength(logs)
  h.advance(60001)
  expect(h.request('POST', 'result', agent, body, jsonHeader).statusCode).toBe(200)
  expect(h.writes()).toBe(before + 1)
})

test('poll rate limits are per node, refill, and allow the normal 12-second interval', () => {
  const h = harness()
  for (let index = 0; index < 6; index++)
    expect(h.request('POST', 'poll', agent, '{}', jsonHeader).statusCode).toBe(204)
  expect(h.request('GET', 'poll', agent).statusCode).toBe(429)
  expect(h.request('GET', 'poll', { type: 'agent', client_uuid: 'other-client' }).statusCode).toBe(204)
  for (let index = 0; index < 12; index++) {
    h.advance(12000)
    expect(h.request('POST', 'poll', agent, '{}', jsonHeader).statusCode).toBe(204)
  }
})

test('malformed JSON errors cannot echo request tokens and storage failure retries remain bounded', () => {
  const h = harness()
  const response = h.request('POST', 'poll', agent, '{"token":"secret-token', jsonHeader)
  expect(response.statusCode).toBe(400)
  expect(response.payload).not.toContain('secret-token')
  expect(h.request('POST', 'poll', agent, 'null', jsonHeader).statusCode).toBe(400)
  h.fault(true)
  h.enqueue()
  const before = h.writes()
  h.request('GET', 'health', admin, '', guard)
  expect(h.writes()).toBe(before)
  h.advance(15000)
  h.fault(false)
  const health = JSON.parse(h.request('GET', 'health', admin, '', guard).payload)
  expect(health.storage.status).toBe('healthy')
  expect(h.writes()).toBe(before + 1)
  expect(h.logs.join('\n')).not.toContain('secret-token')
})

test('limiter has a bounded client table and expires inactive entries', () => {
  let now = 0
  const limiter = new ClientRequestLimiter(() => now)
  for (let index = 0; index < 5000; index++)
    expect(limiter.take(`node-${index}`, 'poll')).toBe(0)
  let scans = 0
  const iterate = limiter.clients[Symbol.iterator].bind(limiter.clients)
  limiter.clients[Symbol.iterator] = () => {
    scans++
    return iterate()
  }
  for (let index = 0; index < 100; index++)
    expect(limiter.take(`overflow-${index}`, 'poll')).toBe(60)
  expect(scans).toBe(0)
  expect(limiter.take('overflow', 'poll')).toBe(60)
  now = 600001
  expect(limiter.take('overflow', 'poll')).toBe(0)
  expect(scans).toBe(1)
  expect(limiter.clients.size).toBe(1)
})
