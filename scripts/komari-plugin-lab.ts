import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildRouteTraceCommand } from '../src/utils/routeTrace'

interface Lab {
  baseUrl: string
  version: string
  workspace: string
  dataDir: string
  client: string
  cookie: () => string
  restart: () => Promise<void>
}

const LAB_REQUEST_TIMEOUT_MS = 15_000

/** Bound every real plugin request so compatibility failures remain actionable. */
async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return await globalThis.fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(LAB_REQUEST_TIMEOUT_MS),
  })
}

/** Uses only the disposable lab server and its generated clients, never operator targets. */
export async function verifyRouteProbeLab(lab: Lab): Promise<void> {
  const headers = () => ({ 'cookie': lab.cookie(), 'X-Transit-Route-Probe': '1' })
  let sequence = 0
  async function rpc<T>(method: string, params: object = {}, authenticated = true): Promise<T> {
    const response = await fetch(`${lab.baseUrl}/api/rpc2`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? headers() : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
    assert(response.ok, `${method}: HTTP ${response.status}`)
    const payload = await response.json() as { error?: { code: number, message?: string }, result?: T }
    assert(!payload.error, `${method}: RPC ${payload.error?.code} ${payload.error?.message ?? ''}`)
    return payload.result as T
  }
  if (lab.version.startsWith('1.2.')) {
    // Released legacy binaries require an active Agent connection, not just a stored report.
    // This lab socket receives and inspects the fixed command; it never executes it.
    const { token } = await rpc<{ token: string }>('admin:getClientToken', { uuid: lab.client })
    const socket = new WebSocket(`${lab.baseUrl.replace(/^http/, 'ws')}/api/clients/report?token=${encodeURIComponent(token)}`)
    const frames: Array<{ message?: string, command?: string, task_id?: string }> = []
    socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
    const sendReport = () => socket.send(JSON.stringify({ uuid: lab.client, cpu: { usage: 1 } }))
    let heartbeat: ReturnType<typeof setInterval> | undefined
    async function waitFor(predicate: () => Promise<boolean>, message: string) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await predicate())
          return
        await delay(50)
      }
      assert.fail(message)
    }
    try {
      await waitFor(async () => socket.readyState === WebSocket.OPEN, 'legacy Agent socket must open')
      sendReport()
      heartbeat = setInterval(sendReport, 1000)
      await waitFor(async () => Boolean((await rpc<Record<string, unknown>>('common:getNodesLatestStatus'))[lab.client]), 'legacy client must report before dispatch')
      const command = buildRouteTraceCommand('beijing')
      const result = await rpc<{ task_id: string }>('admin:exec', { clients: [lab.client], command })
      assert(result.task_id, 'fixed admin:exec fallback must create a real lab task')
      await waitFor(async () => frames.some(frame => frame.task_id === result.task_id), 'legacy Agent must receive the task')
      const frame = frames.find(frame => frame.task_id === result.task_id)!
      assert.equal(frame.message, 'exec')
      assert.equal(frame.command, command)
      const stored = await rpc<{ command: string, clients: string[] }>('admin:getTaskById', { task_id: result.task_id })
      assert.equal(stored.command, command)
      assert(stored.clients.includes(lab.client))
    }
    finally {
      clearInterval(heartbeat)
      socket.close()
    }
    return
  }

  execFileSync('bun', ['run', 'build:route-probe'], { cwd: lab.workspace, stdio: 'pipe' })
  const zip = new Uint8Array(readFileSync(join(lab.workspace, 'transit-route-probe-plugin.zip')))
  const short = 'transit-route-probe'
  async function api(path: string, init: RequestInit) {
    const response = await fetch(`${lab.baseUrl}${path}`, { ...init, headers: { ...headers(), ...init.headers } })
    const payload = await response.json() as { status: string, data?: { upload_id?: string, chunk_size?: number } }
    assert(response.ok && payload.status === 'success', `${path}: HTTP ${response.status}`)
    return payload.data
  }
  async function install() {
    if (lab.version === '1.4.2') {
      await api('/api/admin/plugin/install', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip })
    }
    else {
      const session = await api('/api/admin/upload/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'plugin', filename: 'transit-route-probe-plugin.zip', size: zip.length }) })
      assert(session?.upload_id && session.chunk_size && session.chunk_size > zip.length)
      const form = new FormData()
      form.append('upload_id', session.upload_id)
      form.append('chunk_index', '0')
      form.append('chunk_data', new Blob([zip]), 'chunk-0')
      await api('/api/admin/upload/chunk', { method: 'POST', body: form })
      await api('/api/admin/upload/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_id: session.upload_id }) })
    }
    await rpc('admin:setPluginEnabled', { short, enabled: true, approved: true })
  }
  const root = `${lab.baseUrl}/api/transit-route-probe/v1`
  async function plugin<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(root + path, { ...init, headers: { ...headers(), ...init.headers } })
    assert(response.ok, `route-probe ${path.split('?')[0]}: HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  interface Batch { batch_id: string, jobs: Array<{ client: string, status: string }> }
  const enqueue = () => plugin<Batch>('/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clients: [lab.client], city: 'beijing' }) })
  await install()
  const version = JSON.parse(readFileSync(join(lab.workspace, 'komari-theme.json'), 'utf8')).version
  const health = await plugin<{ ok: boolean, version: string, storage: { status: string } }>('/health')
  assert.equal(health.ok, true)
  assert.equal(health.version, version)
  assert.equal(health.storage.status, 'healthy')
  assert.equal((await fetch(`${root}/health`)).status, 403)
  const { token } = await rpc<{ token: string }>('admin:getClientToken', { uuid: lab.client })
  const poll = () => fetch(`${root}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `Transit-Route-Probe/${version}` }, body: JSON.stringify({ token }) })
  assert.equal((await fetch(`${root}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid-lab-token' }) })).status, 401)
  const batch = await enqueue()
  const lease = await poll()
  assert.equal(lease.status, 200)
  const [jobId, city] = (await lease.text()).trim().split('\t')
  assert(jobId && /^[\w-]{8,96}$/.test(jobId))
  assert.equal(city, 'beijing')
  assert.equal((await fetch(`${root}/poll?token=${encodeURIComponent(token)}`, { headers: { 'User-Agent': 'Transit-Route-Probe/1.3.12' } })).status, 204, 'legacy helper remains supported without duplicating a lease')

  const file = join(lab.dataDir, 'plugin-data', short, 'state-v1.json')
  assert(existsSync(file), 'real goja fs must checkpoint state')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert(!readFileSync(file, 'utf8').includes(token), 'tokens must never reach storage')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert(saved.batches.find((entry: { id: string }) => entry.id === batch.batch_id).jobIds.includes(jobId))
  await install()
  assert.equal((await plugin<Batch>(`/status?batch_id=${batch.batch_id}`)).jobs[0]?.status, 'running', 'upgrade must preserve leases')
  await lab.restart()
  assert.equal((await plugin<Batch>(`/status?batch_id=${batch.batch_id}`)).jobs[0]?.status, 'running', 'restart must restore leases')
  const result = await fetch(`${root}/result?token=${encodeURIComponent(token)}`, { method: 'POST', body: new URLSearchParams({ job_id: jobId, error: 'probe-failed' }) })
  assert.equal(result.status, 200, 'old helper without duration_ms remains accepted')

  await rpc('admin:setPluginEnabled', { short, enabled: false })
  // v1.4.0 schema, written only while the disposable plugin is stopped.
  const now = Date.now()
  const oldId = 'j_legacy140'
  const oldBatch = 'b_legacy140'
  writeFileSync(file, JSON.stringify({ version: 1, saved_at: now, jobs: [{ id: oldId, client: lab.client, city: 'beijing', createdAt: now, updatedAt: now, status: 'queued', leaseUntil: 0, attempts: 0, tag: null, error: null }], batches: [{ id: oldBatch, createdAt: now, jobIds: [oldId] }], helpers: [{ client: lab.client, helperSeenAt: now, helperVersion: '1.4.0' }] }), { mode: 0o600 })
  await rpc('admin:setPluginEnabled', { short, enabled: true, approved: true })
  assert.equal((await plugin<Batch>(`/status?batch_id=${oldBatch}`)).jobs[0]?.status, 'queued')
  const restoredLease = await poll()
  assert.equal(restoredLease.status, 200, 'old state must retain usable queued jobs')
  assert.equal((await restoredLease.text()).trim(), `${oldId}\tbeijing`)
  const jsonResult = await fetch(`${root}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, job_id: oldId, error: 'probe-failed', duration_ms: 1234 }) })
  assert.equal(jsonResult.status, 200, 'Komari must preserve the JSON body after Agent authentication')
  const roster = await plugin<{ clients: Array<{ helper_version: string, last_duration_ms: number }> }>(`/roster?clients=${lab.client}`)
  assert.equal(roster.clients[0]?.helper_version, version)
  assert.equal(roster.clients[0]?.last_duration_ms, 1234)
  assert(!readFileSync(file, 'utf8').includes(token), 'JSON credentials must not reach storage')
  console.log(`[komari-lab] plugin ${lab.version}: install, auth, lease, upgrade, restart, v1.4.0 state, JSON transport and legacy helper passed`)
}
