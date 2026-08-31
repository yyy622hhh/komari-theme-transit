import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const require = createRequire(import.meta.url)
const { RouteProbeCoordinator } = require('../../companion/transit-route-probe/protocol.cjs')
const { StorageCheckpoint } = require('../../companion/transit-route-probe/storage.cjs')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function harness() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'transit-storage-test-'))
  directories.push(directory)
  let now = Date.now()
  let fault = ''
  let writes = 0
  let sequence = 0
  const warnings: string[] = []
  const coordinator = new RouteProbeCoordinator({ now: () => now, randomId: () => `live-${String(++sequence).padStart(24, '0')}` })
  const storageFs = { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    writes++
    if (fault === 'EACCES' || fault === 'ENOSPC')
      throw Object.assign(new Error('secret-path secret-token'), { code: fault })
    fs.writeFileSync(...args)
  }, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (fault === 'rename')
      throw new Error('secret-path secret-token')
    fs.renameSync(...args)
  }, readFileSync: (...args: any[]) => {
    if (fault === 'read')
      throw Object.assign(new Error('secret-path'), { code: 'EACCES' })
    return (fs.readFileSync as any)(...args)
  } }
  const storage = new StorageCheckpoint({ fs: storageFs, path, directory, coordinator, now: () => now, warn: (message: string) => warnings.push(message) })
  return { directory, coordinator, storage, warnings, file: path.join(directory, 'state-v1.json'), fault: (value: string) => {
    fault = value
  }, advance: (ms: number) => {
    now += ms
  }, writes: () => writes }
}

describe('executed plugin storage recovery', () => {
  for (const savedRunning of [false, true]) {
    for (const liveRunning of [false, true]) {
      test(`read recovery reconciles duplicate jobs: saved running=${savedRunning}, live running=${liveRunning}`, () => {
        const h = harness()
        const now = h.coordinator.exportState().saved_at
        let id = 0
        const saved = new RouteProbeCoordinator({ now: () => now - 1000, randomId: () => `saved-${String(++id).padStart(24, '0')}` })
        const oldBatch = saved.enqueue(['client-a'], 'beijing')
        const oldLease = savedRunning ? saved.poll('client-a') : null
        fs.writeFileSync(h.file, JSON.stringify(saved.exportState()))
        h.fault('read')
        h.storage.checkpoint()
        const newBatch = h.coordinator.enqueue(['client-a'], 'beijing')
        const liveLease = liveRunning ? h.coordinator.poll('client-a') : null
        h.fault('')
        h.advance(15_000)
        h.storage.checkpoint()
        const active = h.coordinator.exportState().jobs.filter((job: any) => ['queued', 'running'].includes(job.status))
        expect(active).toHaveLength(1)
        if (liveRunning)
          expect(active[0].id).toBe(liveLease.id)
        else if (savedRunning)
          expect(active[0].id).toBe(oldLease.id)
        const winner = h.coordinator.poll('client-a') ?? { id: active[0].id }
        expect(h.coordinator.poll('client-a')).toBeNull()
        const redundant = h.coordinator.exportState().jobs.find((job: any) => job.id !== winner.id)
        h.coordinator.submit('client-a', { job_id: redundant.id, error: 'probe-failed' })
        // Re-enqueue while a lease exists shares it; retiring a duplicate cannot erase its index.
        h.coordinator.enqueue(['client-a'], 'beijing')
        expect(h.coordinator.exportState().jobs.filter((job: any) => ['queued', 'running'].includes(job.status))).toHaveLength(1)
        h.storage.checkpoint()
        const restarted = new RouteProbeCoordinator({ now: () => now + 15_000 })
        new StorageCheckpoint({ fs, path, directory: h.directory, coordinator: restarted, now: () => now + 15_000 }).restore()
        expect(restarted.poll('client-a')).toBeNull()
        expect(restarted.exportState().jobs.filter((job: any) => job.status === 'running')).toHaveLength(1)
        h.coordinator.submit('client-a', { job_id: winner.id, error: 'no-traceroute' })
        expect(h.coordinator.status(oldBatch.batch_id).jobs[0].status).toBe('failed')
        expect(h.coordinator.status(newBatch.batch_id).jobs[0].status).toBe('failed')
      })
    }
  }
  test('a completed live probe does not resurrect an older queued disk job', () => {
    const h = harness()
    const now = h.coordinator.exportState().saved_at
    const saved = new RouteProbeCoordinator({ now: () => now - 1000, randomId: () => 'old-completed-test' })
    const oldBatch = saved.enqueue(['client-a'], 'beijing')
    fs.writeFileSync(h.file, JSON.stringify(saved.exportState()))
    h.fault('read')
    h.storage.checkpoint()
    const liveBatch = h.coordinator.enqueue(['client-a'], 'beijing')
    const lease = h.coordinator.poll('client-a')
    h.coordinator.submit('client-a', { job_id: lease.id, tag: `transit-route:ct=4134,cu=4837,cm=9808@${Math.floor(now / 1000)}` })
    h.fault('')
    h.advance(15_000)
    h.storage.checkpoint()
    expect(h.coordinator.poll('client-a')).toBeNull()
    expect(h.coordinator.status(oldBatch.batch_id).jobs[0].status).toBe('failed')
    expect(h.coordinator.status(liveBatch.batch_id).jobs[0].status).toBe('completed')
  })
  test('restoration expires old work without erasing a fresh index or merging different cities', () => {
    const h = harness()
    const now = h.coordinator.exportState().saved_at
    const old = new RouteProbeCoordinator({ now: () => now - 601_000, randomId: () => 'expired-disk-probe' })
    old.enqueue(['client-a'], 'beijing')
    fs.writeFileSync(h.file, JSON.stringify(old.exportState()))
    h.fault('read')
    h.storage.checkpoint()
    h.coordinator.enqueue(['client-a'], 'beijing')
    h.coordinator.enqueue(['client-a'], 'shanghai')
    h.coordinator.enqueue(['client-b'], 'beijing')
    h.fault('')
    h.advance(15_000)
    h.storage.checkpoint()
    h.coordinator.enqueue(['client-a'], 'beijing')
    const active = h.coordinator.exportState().jobs.filter((job: any) => job.status === 'queued')
    expect(active).toHaveLength(3)
    expect(new Set(active.map((job: any) => `${job.client}/${job.city}`)).size).toBe(3)
  })
  test('failed checkpoint keeps accepted jobs and dirty state until a later request saves them', () => {
    const h = harness()
    h.storage.checkpoint()
    const batch = h.coordinator.enqueue(['client-a'], 'beijing')
    h.fault('ENOSPC')
    h.storage.checkpoint()
    expect(h.coordinator.hasTaskStateChanges()).toBeTrue()
    expect(h.coordinator.status(batch.batch_id).jobs[0].status).toBe('queued')
    const lease = h.coordinator.poll('client-a', { version: '1.3.12' })
    expect(lease).not.toBeNull()
    h.storage.checkpoint()
    h.fault('')
    h.advance(15_000)
    h.storage.checkpoint()
    expect(h.coordinator.hasTaskStateChanges()).toBeFalse()
    const restarted = new RouteProbeCoordinator()
    const storage = new StorageCheckpoint({ fs, path, directory: h.directory, coordinator: restarted })
    storage.restore()
    expect(restarted.status(batch.batch_id).jobs[0].status).toBe('running')
  })
  test('atomic snapshot uses 0600, restores v1 state and never serializes credentials', () => {
    const h = harness()
    fs.writeFileSync(`${h.file}.tmp`, 'stale temporary data', { mode: 0o644 })
    h.coordinator.poll('client-a', { version: '1.4.0', token: 'secret-token' })
    h.storage.checkpoint()
    expect(fs.readFileSync(h.file, 'utf8')).not.toContain('secret-token')
    expect(fs.statSync(h.file).mode & 0o777).toBe(0o600)
    const restarted = new RouteProbeCoordinator()
    const storage = new StorageCheckpoint({ fs, path, directory: h.directory, coordinator: restarted })
    storage.restore()
    expect(restarted.roster(['client-a']).clients[0].helper_version).toBe('1.4.0')
    expect(h.storage.snapshot().status).toBe('healthy')
  })
  test('permission and no-space faults back off at 15/30/60 seconds and recover', () => {
    for (const error of ['EACCES', 'ENOSPC']) {
      const h = harness()
      h.storage.checkpoint()
      const before = fs.readFileSync(h.file, 'utf8')
      h.fault(error)
      h.storage.persist()
      const count = h.writes()
      h.storage.persist()
      h.storage.checkpoint()
      expect(h.writes()).toBe(count)
      h.advance(15_000)
      h.storage.checkpoint()
      expect(h.writes()).toBe(count + 1)
      h.advance(29_999)
      h.storage.checkpoint()
      expect(h.writes()).toBe(count + 1)
      h.advance(1)
      h.storage.checkpoint()
      h.advance(59_999)
      h.storage.checkpoint()
      expect(h.writes()).toBe(count + 2)
      expect(fs.readFileSync(h.file, 'utf8')).toBe(before)
      expect(h.warnings.filter(line => line.includes('degraded'))).toHaveLength(1)
      expect(h.warnings.join()).not.toContain('secret')
      h.fault('')
      h.advance(1)
      h.storage.checkpoint()
      expect(h.storage.snapshot()).toMatchObject({ status: 'healthy', last_error: null })
    }
  })
  test('failed rename preserves old file and removes temporary file', () => {
    const h = harness()
    h.storage.persist()
    const old = fs.readFileSync(h.file, 'utf8')
    h.fault('rename')
    h.storage.persist()
    expect(fs.readFileSync(h.file, 'utf8')).toBe(old)
    expect(fs.existsSync(`${h.file}.tmp`)).toBeFalse()
    expect(h.storage.snapshot().last_error).toBe('io-error')
  })
  test('corrupt file is retained and load starts empty', () => {
    const h = harness()
    fs.writeFileSync(h.file, '{broken')
    h.storage.checkpoint()
    expect(h.storage.snapshot()).toMatchObject({ status: 'healthy', recovered_from_corrupt: true })
    const copy = fs.readdirSync(h.directory).find(name => name.startsWith('state-v1.corrupt-'))!
    expect(fs.readFileSync(path.join(h.directory, copy), 'utf8')).toBe('{broken')
    expect(JSON.parse(fs.readFileSync(h.file, 'utf8')).jobs).toEqual([])
  })
  test('read failure is not corruption and recovery retains newly accepted memory state', () => {
    const h = harness()
    fs.writeFileSync(h.file, JSON.stringify({ version: 1, jobs: [], batches: [], helpers: [] }))
    h.fault('read')
    h.storage.checkpoint()
    h.coordinator.poll('client-b', { version: '1.4.1' })
    h.fault('')
    h.advance(15_000)
    h.storage.checkpoint()
    expect(JSON.parse(fs.readFileSync(h.file, 'utf8')).helpers[0].client).toBe('client-b')
    expect(h.storage.snapshot().recovered_from_corrupt).toBeFalse()
  })
  test('healthy heartbeats checkpoint once a minute and missing directory is observable', () => {
    const h = harness()
    h.storage.checkpoint()
    h.storage.checkpoint()
    expect(h.writes()).toBe(1)
    h.advance(60_000)
    h.storage.checkpoint()
    expect(h.writes()).toBe(2)
    const missing = new StorageCheckpoint({ fs, path, directory: '', coordinator: h.coordinator })
    expect(missing.snapshot().status).toBe('unavailable')
  })
  for (const version of [undefined, '1.4.1']) {
    test(`read recovery merges ${version ?? 'legacy'} heartbeat without erasing persisted helper history`, () => {
      const h = harness()
      const now = h.coordinator.exportState().saved_at
      const helper = { client: 'client-a', helperSeenAt: now - 1000, helperVersion: '1.4.0', lastJobAt: now - 5000, lastSuccessAt: now - 20_000, lastError: 'probe-failed', lastDurationMs: 0 }
      fs.writeFileSync(h.file, JSON.stringify({ version: 1, jobs: [], batches: [], helpers: [helper] }))
      h.fault('read')
      h.storage.checkpoint()
      h.coordinator.poll('client-a', { version })
      h.fault('')
      h.advance(15_000)
      h.storage.checkpoint()
      const expected = { client: 'client-a', helper_seen_at: now, active_job_until: null, helper_version: version ?? '1.4.0', last_job_at: helper.lastJobAt, last_success_at: helper.lastSuccessAt, last_error: helper.lastError, last_duration_ms: 0 }
      expect(h.coordinator.roster(['client-a']).clients[0]).toEqual(expected)
      const restarted = new RouteProbeCoordinator({ now: () => now + 15_000 })
      new StorageCheckpoint({ fs, path, directory: h.directory, coordinator: restarted }).restore()
      expect(restarted.roster(['client-a']).clients[0]).toEqual(expected)
    })
  }
  for (const success of [false, true]) {
    test(`new ${success ? 'successful' : 'failed'} result during read failure takes precedence over saved result fields`, () => {
      const h = harness()
      const now = h.coordinator.exportState().saved_at
      const helper = { client: 'client-a', helperSeenAt: now - 1000, lastJobAt: now - 5000, lastSuccessAt: now - 20_000, lastError: 'probe-failed', lastDurationMs: 123 }
      fs.writeFileSync(h.file, JSON.stringify({ version: 1, jobs: [], batches: [], helpers: [helper] }))
      h.fault('read')
      h.storage.checkpoint()
      h.coordinator.enqueue(['client-a'], 'beijing')
      const lease = h.coordinator.poll('client-a')
      h.coordinator.submit('client-a', { job_id: lease.id, duration_ms: 0, ...(success ? { tag: `transit-route:ct=4134,cu=4837,cm=9808@${Math.floor(now / 1000)}` } : { error: 'no-traceroute' }) })
      h.fault('')
      h.advance(15_000)
      h.storage.checkpoint()
      expect(h.coordinator.roster(['client-a']).clients[0]).toMatchObject({ last_job_at: now, last_success_at: success ? now : helper.lastSuccessAt, last_error: success ? null : 'no-traceroute', last_duration_ms: 0 })
      expect(h.storage.snapshot().status).toBe('healthy')
    })
  }
})
