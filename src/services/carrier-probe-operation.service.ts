import type { AdminPingTask } from '@/services/ping-task.model'

export type CarrierOperationPhase = 'creating' | 'sampling' | 'checking' | 'deleting' | 'cleanup' | 'done' | 'failed' | 'recovery'
export interface CarrierOperationRecord {
  id: string
  key: string
  kind: 'verify' | 'migrate' | 'rebuild'
  original: AdminPingTask
  created: AdminPingTask[]
  phase: CarrierOperationPhase
  startedAt: number
  updatedAt: number
  message: string
  uncertainCreation?: boolean
}
const PREFIX = 'transit:carrier-operation:v1:'
const MAX_RECENT_NON_RECOVERY_OPERATIONS = 20
const TERMINAL = new Set<CarrierOperationPhase>(['done', 'failed', 'recovery'])

export function carrierTaskSnapshot(task: AdminPingTask): string {
  return JSON.stringify([task.id, task.name, task.type, task.target, [...task.clients].sort(), task.interval, Boolean(task.default_on)])
}

function validTask(value: unknown): value is AdminPingTask {
  if (!value || typeof value !== 'object')
    return false
  const task = value as AdminPingTask
  return Number.isInteger(task.id) && task.id! > 0 && typeof task.name === 'string'
    && typeof task.target === 'string' && typeof task.type === 'string'
    && Number.isFinite(task.interval) && Array.isArray(task.clients) && task.clients.every(id => typeof id === 'string')
}

export function readCarrierOperations(): CarrierOperationRecord[] {
  if (typeof localStorage === 'undefined')
    return []
  const records: CarrierOperationRecord[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(PREFIX))
        continue
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? '') as CarrierOperationRecord
        if (typeof value.id === 'string' && key === PREFIX + value.id && validTask(value.original)
          && Array.isArray(value.created) && value.created.every(validTask) && Number.isFinite(value.startedAt)
          && Number.isFinite(value.updatedAt) && typeof value.message === 'string'
          && ['verify', 'migrate', 'rebuild'].includes(value.kind)
          && ['creating', 'sampling', 'checking', 'deleting', 'cleanup', 'done', 'failed', 'recovery'].includes(value.phase)) {
          records.push(value)
        }
      }
      catch {}
    }
  }
  catch {}
  return records.sort((a, b) => b.startedAt - a.startedAt)
}

export function selectCarrierOperationIdsToRetain(records: readonly CarrierOperationRecord[]): Set<string> {
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt)
  const recoveryRelevant = sorted.filter(record => record.phase !== 'done'
    && (record.phase === 'creating' || record.uncertainCreation === true || record.created.length > 0))
  const recoveryIds = new Set(recoveryRelevant.map(record => record.id))
  const recentCompleted = sorted
    .filter(record => !recoveryIds.has(record.id))
    .slice(0, MAX_RECENT_NON_RECOVERY_OPERATIONS)
  return new Set([...recoveryRelevant, ...recentCompleted].map(record => record.id))
}

function pruneCarrierOperations(): void {
  const records = readCarrierOperations()
  const retained = selectCarrierOperationIdsToRetain(records)
  for (const record of records) {
    if (!retained.has(record.id))
      localStorage.removeItem(PREFIX + record.id)
  }
}

export function saveCarrierOperation(record: CarrierOperationRecord): void {
  if (typeof localStorage === 'undefined')
    return
  // Explicit projection: credentials and arbitrary backend fields never enter the journal.
  const cleanTask = (task: AdminPingTask): AdminPingTask => ({ id: task.id, name: task.name, target: task.target, type: task.type, clients: [...task.clients], interval: task.interval, default_on: Boolean(task.default_on) })
  localStorage.setItem(PREFIX + record.id, JSON.stringify({ ...record, original: cleanTask(record.original), created: record.created.map(cleanTask) }))
  if (TERMINAL.has(record.phase))
    pruneCarrierOperations()
}

export function protectedCarrierTaskIds(now = Date.now()): Set<number> {
  return new Set(readCarrierOperations().filter(record => !TERMINAL.has(record.phase) && now - record.updatedAt < 10 * 60_000).flatMap(record => record.created.map(task => task.id!)))
}

export async function heldCarrierTaskIds(): Promise<Set<number>> {
  const protectedIds = protectedCarrierTaskIds()
  if (!supportsCarrierMutationLock())
    return protectedIds
  const records = readCarrierOperations()
  try {
    const locks = await navigator.locks.query()
    const held = new Set(locks.held?.map(lock => lock.name))
    for (const record of records) {
      if (held.has(`transit:carrier:${record.original.id}`))
        record.created.forEach(task => protectedIds.add(task.id!))
    }
  }
  catch {
    // Unknown lock ownership must not authorize automatic deletion.
    records.forEach(record => record.created.forEach(task => protectedIds.add(task.id!)))
  }
  return protectedIds
}

export function supportsCarrierMutationLock(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks)
}

const running = new Set<number>()
export async function withCarrierOperationLock<T>(taskId: number, mutation: boolean, run: () => Promise<T>): Promise<T> {
  if (running.has(taskId))
    throw new Error('此任务已有操作进行中。')
  if (mutation && !supportsCarrierMutationLock())
    throw new Error('此浏览器不支持 Web Locks；为避免并发迁移，请使用支持的浏览器。查看和验证不受影响。')
  running.add(taskId)
  try {
    if (!supportsCarrierMutationLock())
      return await run()
    return await navigator.locks.request(`transit:carrier:${taskId}`, { ifAvailable: true }, async (lock) => {
      if (!lock)
        throw new Error('其他标签页正在操作此任务，请等待完成后刷新。')
      return run()
    })
  }
  finally {
    running.delete(taskId)
  }
}

/** Read-only reconciliation. Journal IDs are clues, not permission to delete. */
export function reconcileCarrierOperation(record: CarrierOperationRecord, tasks: readonly AdminPingTask[]): CarrierOperationRecord {
  const original = tasks.find(task => task.id === record.original.id)
  const remaining = record.created.filter(created => tasks.some(task => task.id === created.id))
  const changed = original && carrierTaskSnapshot(original) !== carrierTaskSnapshot(record.original)
  return { ...record, phase: 'recovery', message: `${changed ? '原任务已被修改' : original ? '原任务仍在' : '原任务已不存在'}；本次资源仍在：${remaining.map(task => task.id).join('、') || '无'}。${record.uncertainCreation ? '创建响应未确认，可能另有未知 ID，请在后台按名称核对。' : ''}仅回查，未执行任何变更。` }
}
