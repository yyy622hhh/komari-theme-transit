'use strict'

// Komari's goja module registry exposes the compatibility name, not `node:crypto`.
// eslint-disable-next-line unicorn/prefer-node-protocol
const crypto = require('crypto')
const server = require('server')
const { RouteProbeCoordinator } = require('./protocol.cjs')

const API_ROOT = '/api/transit-route-probe/v1'
// Kept in sync with komari-plugin.json's "version" by scripts/publish.ts (same as
// helper.sh's own VERSION constant) rather than `require('./komari-plugin.json')` —
// Komari's goja module loader has never been exercised against a JSON require
// anywhere in this plugin, and a load-time failure there would take down every route.
const PLUGIN_VERSION = '1.3.11'
const coordinator = new RouteProbeCoordinator({
  // Hex is supported by every Buffer implementation bundled with Komari's
  // goja runtime; unlike base64url it also needs no punctuation filtering.
  randomId: () => crypto.randomBytes(18).toString('hex'),
})

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
  return JSON.parse(req.body)
}

function parseFormBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/x-www-form-urlencoded'))
    throw new TypeError('form body required')
  if (req.body.length > 4096)
    throw new TypeError('request body too large')
  const result = {}
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

function load() {
  server.route('GET', `${API_ROOT}/health`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    return json(res, 200, { ok: true, protocol: 1, version: PLUGIN_VERSION })
  })

  server.route('POST', `${API_ROOT}/enqueue`, (req, res) => {
    if (!isAdmin(req) || !hasBrowserGuard(req))
      return json(res, 403, { error: 'admin authentication required' })
    try {
      const body = parseJsonBody(req)
      const batch = coordinator.enqueue(body.clients, body.city)
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
      return json(res, 200, coordinator.status(req.query.batch_id))
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
      return json(res, 200, coordinator.roster(clients))
    }
    catch (error) {
      return handleError(res, error)
    }
  })

  server.route('GET', `${API_ROOT}/poll`, (req, res) => {
    const client = agentClient(req)
    if (!client)
      return text(res, 401, 'agent token required\n')
    try {
      const job = coordinator.poll(client)
      if (!job)
        return text(res, 204)
      console.warn(`[route-probe] leased ${job.id} to ${client}`)
      return text(res, 200, `${job.id}\t${job.city}\n`)
    }
    catch (error) {
      return handleError(res, error)
    }
  })

  server.route('POST', `${API_ROOT}/result`, (req, res) => {
    const client = agentClient(req)
    if (!client)
      return text(res, 401, 'agent token required\n')
    try {
      const result = coordinator.submit(client, parseFormBody(req))
      console.warn(`[route-probe] accepted result for ${client}: ${result.status}`)
      return json(res, 200, result)
    }
    catch (error) {
      return handleError(res, error)
    }
  })
}

globalThis.load = load
