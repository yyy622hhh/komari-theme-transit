'use strict'

// Komari's goja module registry exposes the compatibility name, not `node:crypto`.
// eslint-disable-next-line unicorn/prefer-node-protocol
const crypto = require('crypto')
// Komari's goja module registry exposes the compatibility names.
// eslint-disable-next-line unicorn/prefer-node-protocol
const fs = require('fs')
// eslint-disable-next-line unicorn/prefer-node-protocol
const path = require('path')
const server = require('server')
const { RouteProbeCoordinator } = require('./protocol.cjs')
const { ClientRequestLimiter } = require('./request-limits.cjs')

const API_ROOT = '/api/transit-route-probe/v1'
// Kept in sync with komari-plugin.json's "version" by scripts/publish.ts (same as
// helper.sh's own VERSION constant) rather than `require('./komari-plugin.json')` —
// Komari's goja module loader has never been exercised against a JSON require
// anywhere in this plugin, and a load-time failure there would take down every route.
const PLUGIN_VERSION = '1.4.2'
const { StorageCheckpoint } = require('./storage.cjs')

const coordinator = new RouteProbeCoordinator({ randomId: () => crypto.randomBytes(18).toString('hex') })
const limiter = new ClientRequestLimiter()
const storage = new StorageCheckpoint({
  fs,
  path,
  coordinator,
  directory: typeof globalThis.__storageDir__ === 'string' ? globalThis.__storageDir__ : '',
  warn: message => console.warn(message),
})
function persistState() {
  storage.persist()
}
function checkpointHeartbeat() {
  storage.checkpoint()
}
function restoreState() {
  storage.restore()
  storage.checkpoint()
}

function helperVersion(req) {
  const explicit = String(req.headers['x-transit-route-probe-version'] || '').trim()
  if (explicit)
    return explicit
  const match = /Transit-Route-Probe\/(\S+)/i.exec(String(req.headers['user-agent'] || ''))
  return match ? match[1] : ''
}

restoreState()

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function text(res, status, payload = '') {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

function principal(req) {
  return req.context && req.context.principal ? req.context.principal : null
}

function isAdmin(req) {
  const identity = principal(req)
  const roles = identity && Array.isArray(identity.roles) ? identity.roles : []
  return identity && identity.type === 'user'
    && (req.context.role === 'admin' || roles.includes('admin'))
}

function agentClient(req) {
  const identity = principal(req)
  if (!identity || identity.type !== 'agent')
    return ''
  return identity.client_uuid || req.context.client_uuid || ''
}

function hasBrowserGuard(req) {
  const marker = req.headers['x-transit-route-probe']
  const site = req.headers['sec-fetch-site']
  return marker === '1' && (!site || site === 'same-origin')
}

function parseJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/json'))
    throw new TypeError('application/json required')
  if (!req.body || req.body.length > 8192)
    throw new TypeError('invalid request body')
  let body
  try {
    body = JSON.parse(req.body)
  }
  catch { throw new TypeError('invalid JSON body') }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new TypeError('JSON object required')
  return body
}

function parseFormBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/x-www-form-urlencoded'))
    throw new TypeError('form body required')
  if (req.body.length > 4096)
    throw new TypeError('request body too large')
  const result = Object.create(null)
  for (const pair of req.body.split('&')) {
    const separator = pair.indexOf('=')
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : ''
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    result[key] = value
  }
  return result
}

function handleError(res, error) {
  const message = error && error.message ? error.message : 'request failed'
  if (message === 'batch not found' || message === 'job not found')
    return json(res, 404, { error: message })
  if (message === 'job belongs to another client')
    return json(res, 403, { error: message })
  return json(res, error instanceof TypeError ? 400 : 409, { error: message })
}

function isLimited(res, client, kind) {
  const retry = limiter.take(client, kind)
  if (!retry)
    return false
  res.setHeader('Retry-After', String(retry))
  text(res, 429, 'too many requests\n')
  return true
}

function poll(req, res) {
  const client = agentClient(req)
  if (!client) {
    res.setHeader('Retry-After', '300')
    return text(res, 401, 'agent token required\n')
  }
  if (isLimited(res, client, 'poll'))
    return
  try {
    if (req.method === 'POST')
      parseJsonBody(req)
    const job = coordinator.poll(client, { version: helperVersion(req) })
    if (!job) {
      checkpointHeartbeat()
      return text(res, 204)
    }
    persistState()
    console.warn(`[route-probe] leased ${job.id} to ${client}`)
    return text(res, 200, `${job.id}\t${job.city}\n`)
  }
  catch (error) { return handleError(res, error) }
}

function load() {
  server.route('GET', `${API_ROOT}/health`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    checkpointHeartbeat()
    return json(res, 200, { ok: true, protocol: 1, version: PLUGIN_VERSION, storage: storage.snapshot() })
  })

  server.route('POST', `${API_ROOT}/enqueue`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    try {
      const body = parseJsonBody(req)
      const batch = coordinator.enqueue(body.clients, body.city)
      persistState()
      console.warn(`[route-probe] queued ${batch.jobs.length} client(s) in ${batch.batch_id}`)
      return json(res, 202, batch)
    }
    catch (error) {
      return handleError(res, error)
    }
  })

  server.route('GET', `${API_ROOT}/status`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    try {
      const status = coordinator.status(req.query.batch_id)
      checkpointHeartbeat()
      return json(res, 200, status)
    }
    catch (error) {
      return handleError(res, error)
    }
  })

  // 只读花名册：给设置向导的“环境检查”用，判断哪些节点已经有助手在轮询，
  // 不创建、不触碰任何任务，因此不会让在线助手执行一次探测。
  server.route('GET', `${API_ROOT}/roster`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    try {
      const clients = String(req.query.clients || '').split(',').map(value => value.trim()).filter(Boolean)
      const roster = coordinator.roster(clients)
      checkpointHeartbeat()
      return json(res, 200, roster)
    }
    catch (error) {
      return handleError(res, error)
    }
  })

  // Komari resolves agent identity from JSON token before invoking routes.
  // Keep legacy GET/form callers; new helpers never fall back to URL credentials.
  server.route('GET', `${API_ROOT}/poll`, poll)
  server.route('POST', `${API_ROOT}/poll`, poll)

  server.route('POST', `${API_ROOT}/result`, (req, res) => {
    const client = agentClient(req)
    if (!client)
      return text(res, 401, 'agent token required\n')
    if (isLimited(res, client, 'result'))
      return
    try {
      const body = String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')
        ? parseJsonBody(req)
        : parseFormBody(req)
      const result = coordinator.submit(client, body)
      checkpointHeartbeat()
      if (result.changed)
        console.warn(`[route-probe] accepted result for ${client}: ${result.status}`)
      return json(res, 200, { status: result.status })
    }
    catch (error) {
      return handleError(res, error)
    }
  })
}

globalThis.load = load
globalThis.unload = () => storage.persist(true)
