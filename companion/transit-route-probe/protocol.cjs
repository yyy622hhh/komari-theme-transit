'use strict'

const VALID_CITIES = new Set(['beijing', 'shanghai', 'guangzhou'])
const VALID_ERRORS = new Set([
  'no-traceroute',
  'probe-failed',
  'invalid-city',
  'internal-error',
])

const CLIENT_PATTERN = /^[a-z0-9][\w.:-]{0,127}$/i
const ID_PATTERN = /^[\w-]{8,96}$/
const ROUTE_TAG_PATTERN = /^transit-route:ct=([0-9.]*),cu=([0-9.]*),cm=([0-9.]*)@(\d{10,13})$/i

const JOB_TTL_MS = 10 * 60 * 1000
const JOB_LEASE_MS = 180 * 1000
const BATCH_TTL_MS = 20 * 60 * 1000
const MAX_CLIENTS = 20

function assertCity(city) {
  if (!VALID_CITIES.has(city))
    throw new TypeError('unsupported city')
}

function normalizeClients(clients) {
  if (!Array.isArray(clients) || clients.length === 0 || clients.length > MAX_CLIENTS)
    throw new TypeError(`clients must contain 1-${MAX_CLIENTS} entries`)

  const unique = []
  const seen = new Set()
  for (const value of clients) {
    if (typeof value !== 'string' || !CLIENT_PATTERN.test(value))
      throw new TypeError('invalid client identifier')
    if (!seen.has(value)) {
      seen.add(value)
      unique.push(value)
    }
  }
  return unique
}

function validateRouteTag(tag, now = Date.now()) {
  if (typeof tag !== 'string' || tag.length > 2048)
    return false
  const match = ROUTE_TAG_PATTERN.exec(tag)
  if (!match)
    return false
  if (![match[1], match[2], match[3]].some(value => /\d/.test(value)))
    return false

  for (const chain of [match[1], match[2], match[3]]) {
    if (!chain)
      continue
    if (chain.split('.').some(value => !/^\d{1,10}$/.test(value)))
      return false
  }

  const rawTimestamp = Number(match[4])
  const measuredAt = rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000
  return Number.isFinite(measuredAt) && Math.abs(measuredAt - now) <= 15 * 60 * 1000
}

class RouteProbeCoordinator {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.randomId = options.randomId || (() => Math.random().toString(36).slice(2))
    this.jobs = new Map()
    this.batches = new Map()
    this.activeByClientCity = new Map()
    this.lastSeenByClient = new Map()
  }

  enqueue(clients, city) {
    this.cleanup()
    assertCity(city)
    const normalizedClients = normalizeClients(clients)
    const now = this.now()
    const batchId = this.makeId('b')
    const jobIds = []

    for (const client of normalizedClients) {
      const activeKey = `${client}\n${city}`
      let job = this.jobs.get(this.activeByClientCity.get(activeKey))
      if (!job || job.status === 'completed' || job.status === 'failed') {
        job = {
          id: this.makeId('j'),
          client,
          city,
          createdAt: now,
          updatedAt: now,
          status: 'queued',
          leaseUntil: 0,
          attempts: 0,
          tag: null,
          error: null,
        }
        this.jobs.set(job.id, job)
        this.activeByClientCity.set(activeKey, job.id)
      }
      jobIds.push(job.id)
    }

    this.batches.set(batchId, { id: batchId, createdAt: now, jobIds })
    return this.status(batchId)
  }

  poll(client) {
    this.cleanup()
    if (typeof client !== 'string' || !CLIENT_PATTERN.test(client))
      throw new TypeError('invalid client identifier')
    const now = this.now()
    this.lastSeenByClient.set(client, now)

    const candidates = [...this.jobs.values()]
      .filter(job => job.client === client && (
        job.status === 'queued'
        || (job.status === 'running' && job.leaseUntil <= now)
      ))
      .sort((a, b) => a.createdAt - b.createdAt)

    const job = candidates[0]
    if (!job)
      return null
    job.status = 'running'
    job.leaseUntil = now + JOB_LEASE_MS
    job.updatedAt = now
    job.attempts += 1
    return { id: job.id, city: job.city }
  }

  submit(client, payload) {
    this.cleanup()
    if (!payload || typeof payload.job_id !== 'string' || !ID_PATTERN.test(payload.job_id))
      throw new TypeError('invalid job id')
    const job = this.jobs.get(payload.job_id)
    if (!job)
      throw new Error('job not found')
    if (job.client !== client)
      throw new Error('job belongs to another client')
    if (job.status === 'completed' || job.status === 'failed')
      return { status: job.status }
    if (job.status !== 'running')
      throw new Error('job was not leased')

    const now = this.now()
    if (typeof payload.tag === 'string' && payload.tag) {
      if (!validateRouteTag(payload.tag, now))
        throw new TypeError('invalid route tag')
      job.status = 'completed'
      job.tag = payload.tag
      job.error = null
    }
    else {
      if (!VALID_ERRORS.has(payload.error))
        throw new TypeError('invalid probe error')
      job.status = 'failed'
      job.tag = null
      job.error = payload.error
    }
    job.updatedAt = now
    job.leaseUntil = 0
    this.activeByClientCity.delete(`${job.client}\n${job.city}`)
    return { status: job.status }
  }

  status(batchId) {
    this.cleanup()
    if (typeof batchId !== 'string' || !ID_PATTERN.test(batchId))
      throw new TypeError('invalid batch id')
    const batch = this.batches.get(batchId)
    if (!batch)
      throw new Error('batch not found')

    return {
      batch_id: batch.id,
      jobs: batch.jobIds.map((jobId) => {
        const job = this.jobs.get(jobId)
        return {
          client: job.client,
          city: job.city,
          status: job.status,
          tag: job.tag,
          error: job.error,
          attempts: job.attempts,
          helper_seen_at: this.lastSeenByClient.get(job.client) || null,
        }
      }),
    }
  }

  cleanup() {
    const now = this.now()
    for (const job of this.jobs.values()) {
      if ((job.status === 'queued' || job.status === 'running') && now - job.createdAt > JOB_TTL_MS) {
        job.status = 'failed'
        job.error = 'probe-failed'
        job.updatedAt = now
        job.leaseUntil = 0
        this.activeByClientCity.delete(`${job.client}\n${job.city}`)
      }
    }

    for (const [batchId, batch] of this.batches) {
      if (now - batch.createdAt > BATCH_TTL_MS)
        this.batches.delete(batchId)
    }

    const referenced = new Set()
    for (const batch of this.batches.values()) {
      for (const jobId of batch.jobIds)
        referenced.add(jobId)
    }
    for (const [jobId, job] of this.jobs) {
      if (!referenced.has(jobId) && job.status !== 'queued' && job.status !== 'running')
        this.jobs.delete(jobId)
    }
  }

  makeId(prefix) {
    const token = String(this.randomId()).replace(/[^\w-]/g, '').slice(0, 64)
    const id = `${prefix}_${token}`
    if (!ID_PATTERN.test(id))
      throw new Error('random id source returned too little entropy')
    return id
  }
}

module.exports = {
  BATCH_TTL_MS,
  JOB_LEASE_MS,
  JOB_TTL_MS,
  MAX_CLIENTS,
  RouteProbeCoordinator,
  normalizeClients,
  validateRouteTag,
}
