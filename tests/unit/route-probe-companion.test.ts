import { createRequire } from 'node:module'
import { describe, expect, test } from 'bun:test'

const require = createRequire(import.meta.url)
const {
  HELPER_TTL_MS,
  JOB_LEASE_MS,
  RouteProbeCoordinator,
  normalizeClients,
  validateRouteTag,
} = require('../../companion/transit-route-probe/protocol.cjs') as {
  HELPER_TTL_MS: number
  JOB_LEASE_MS: number
  RouteProbeCoordinator: new (options: { now: () => number, randomId: () => string }) => {
    enqueue: (clients: string[], city: string) => CompanionBatch
    poll: (client: string, metadata?: { version?: string }) => { id: string, city: string } | null
    status: (batchId: string) => CompanionBatch
    submit: (client: string, result: Record<string, string | number>) => { status: string }
    roster: (clients: string[]) => { clients: Array<{
      client: string
      helper_seen_at: number | null
      helper_version: string | null
      last_job_at: number | null
      last_success_at: number | null
      last_error: string | null
      last_duration_ms: number | null
    }> }
    exportState: () => Record<string, unknown>
    importState: (state: Record<string, unknown>) => void
  }
  normalizeClients: (clients: string[]) => string[]
  validateRouteTag: (tag: string, now?: number) => boolean
}

interface CompanionBatch {
  batch_id: string
  jobs: Array<{
    client: string
    status: string
    tag: string | null
    error: string | null
    attempts: number
  }>
}

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const CLIENT_A = '11111111-1111-4111-8111-111111111111'
const CLIENT_B = '22222222-2222-4222-8222-222222222222'

function coordinator() {
  let now = NOW
  let sequence = 0
  const value = new RouteProbeCoordinator({
    now: () => now,
    randomId: () => `0123456789abcdef${++sequence}`,
  })
  return { value, advance: (ms: number) => now += ms }
}

describe('Transit Route Probe companion protocol', () => {
  test('只接受固定城市、有限节点并去重', () => {
    expect(normalizeClients([CLIENT_A, CLIENT_A, CLIENT_B])).toEqual([CLIENT_A, CLIENT_B])
    expect(() => coordinator().value.enqueue([CLIENT_A], 'hongkong')).toThrow('unsupported city')
    expect(() => normalizeClients(Array.from({ length: 21 }, (_, index) => `node-${index}`))).toThrow()
    expect(() => normalizeClients(['node;rm -rf'])).toThrow('invalid client identifier')
  })

  test('节点只能领取并提交属于自己的任务', () => {
    const { value } = coordinator()
    const batch = value.enqueue([CLIENT_A], 'beijing')
    expect(value.poll(CLIENT_B)).toBeNull()
    const job = value.poll(CLIENT_A)!
    expect(job.city).toBe('beijing')
    expect(() => value.submit(CLIENT_B, { job_id: job.id, error: 'probe-failed' })).toThrow('another client')

    const tag = `transit-route:ct=4809.4134,cu=9929,cm=58807@${Math.floor(NOW / 1000)}`
    expect(value.submit(CLIENT_A, { job_id: job.id, tag })).toEqual({ status: 'completed' })
    expect(value.status(batch.batch_id).jobs[0]).toMatchObject({ status: 'completed', tag })
  })

  test('租约到期可以由同一节点重新领取，结果提交幂等', () => {
    const { value, advance } = coordinator()
    value.enqueue([CLIENT_A], 'shanghai')
    const first = value.poll(CLIENT_A)!
    advance(JOB_LEASE_MS + 1)
    expect(value.poll(CLIENT_A)).toEqual(first)
    expect(value.submit(CLIENT_A, { job_id: first.id, error: 'no-traceroute' })).toEqual({ status: 'failed' })
    expect(value.submit(CLIENT_A, { job_id: first.id, error: 'no-traceroute' })).toEqual({ status: 'failed' })
  })

  test('拒绝任意错误文本和伪造、过期或空路线标签', () => {
    const { value } = coordinator()
    value.enqueue([CLIENT_A], 'guangzhou')
    const job = value.poll(CLIENT_A)!
    expect(() => value.submit(CLIENT_A, { job_id: job.id, error: 'run: curl attacker' })).toThrow('invalid probe error')
    expect(validateRouteTag(`transit-route:ct=,cu=,cm=@${Math.floor(NOW / 1000)}`, NOW)).toBeFalse()
    expect(validateRouteTag(`transit-route:ct=4809,cu=9929,cm=58807@${Math.floor((NOW - 16 * 60_000) / 1000)}`, NOW)).toBeFalse()
    expect(validateRouteTag(`transit-route:ct=$(id),cu=9929,cm=58807@${Math.floor(NOW / 1000)}`, NOW)).toBeFalse()
  })

  test('相同节点和城市的并发批次复用同一任务', () => {
    const { value } = coordinator()
    const first = value.enqueue([CLIENT_A], 'beijing')
    const second = value.enqueue([CLIENT_A], 'beijing')
    const job = value.poll(CLIENT_A)!
    value.submit(CLIENT_A, {
      job_id: job.id,
      tag: `transit-route:ct=4809,cu=9929,cm=58807@${Math.floor(NOW / 1000)}`,
    })
    expect(value.status(first.batch_id).jobs[0].status).toBe('completed')
    expect(value.status(second.batch_id).jobs[0].status).toBe('completed')
    expect(value.status(second.batch_id).jobs[0].attempts).toBe(1)
  })

  test('花名册只读 lastSeenByClient，不创建任务、不影响候选任务的领取', () => {
    const { value, advance } = coordinator()
    expect(value.roster([CLIENT_A, CLIENT_B])).toEqual({
      clients: [
        { client: CLIENT_A, helper_seen_at: null, helper_version: null, last_job_at: null, last_success_at: null, last_error: null, last_duration_ms: null },
        { client: CLIENT_B, helper_seen_at: null, helper_version: null, last_job_at: null, last_success_at: null, last_error: null, last_duration_ms: null },
      ],
    })

    // 助手在没有任务时轮询也会落 lastSeenByClient，花名册应该能看到这次心跳。
    expect(value.poll(CLIENT_A)).toBeNull()
    advance(1000)
    expect(value.roster([CLIENT_A, CLIENT_B])).toEqual({
      clients: [
        { client: CLIENT_A, helper_seen_at: NOW, helper_version: null, last_job_at: null, last_success_at: null, last_error: null, last_duration_ms: null },
        { client: CLIENT_B, helper_seen_at: null, helper_version: null, last_job_at: null, last_success_at: null, last_error: null, last_duration_ms: null },
      ],
    })

    // 查过花名册之后再入队，任务应该照常存在——花名册不能悄悄吃掉候选。
    const batch = value.enqueue([CLIENT_A], 'beijing')
    expect(value.status(batch.batch_id).jobs[0].status).toBe('queued')
  })

  test('新旧助手兼容并记录版本、最后成功、错误和耗时', () => {
    const { value } = coordinator()
    expect(value.poll(CLIENT_A)).toBeNull()
    expect(value.roster([CLIENT_A]).clients[0]).toMatchObject({ helper_version: null })

    const first = value.enqueue([CLIENT_A], 'beijing')
    const success = value.poll(CLIENT_A, { version: '1.4.0' })!
    value.submit(CLIENT_A, {
      job_id: success.id,
      tag: `transit-route:ct=4809,cu=9929,cm=58807@${Math.floor(NOW / 1000)}`,
      duration_ms: 1234,
    })
    expect(value.roster([CLIENT_A]).clients[0]).toMatchObject({
      helper_version: '1.4.0',
      last_job_at: NOW,
      last_success_at: NOW,
      last_error: null,
      last_duration_ms: 1234,
    })
    expect(value.status(first.batch_id).jobs[0].status).toBe('completed')

    const second = value.enqueue([CLIENT_A], 'shanghai')
    const failed = value.poll(CLIENT_A)!
    value.submit(CLIENT_A, { job_id: failed.id, error: 'probe-failed' })
    expect(value.roster([CLIENT_A]).clients[0]?.last_error).toBe('probe-failed')
    expect(value.status(second.batch_id).jobs[0].status).toBe('failed')
  })

  test('状态可序列化恢复，过期任务失败收口且助手 30 天后淘汰', () => {
    const source = coordinator()
    const batch = source.value.enqueue([CLIENT_A], 'beijing')
    source.value.poll(CLIENT_A, { version: '1.4.0' })
    const state = source.value.exportState()

    const restored = coordinator()
    restored.value.importState(state)
    expect(restored.value.status(batch.batch_id).jobs[0]).toMatchObject({ status: 'running', attempts: 1 })
    expect(restored.value.roster([CLIENT_A]).clients[0]?.helper_version).toBe('1.4.0')

    restored.advance(10 * 60_000 + 1)
    expect(restored.value.status(batch.batch_id).jobs[0]).toMatchObject({ status: 'failed', error: 'probe-failed' })
    restored.advance(HELPER_TTL_MS)
    expect(restored.value.roster([CLIENT_A]).clients[0]?.helper_seen_at).toBeNull()
  })
})
