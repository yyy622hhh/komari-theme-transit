import type { AdminPingTask } from '@/services/ping-task.model'

const STORAGE_KEY = 'transit:topology-created-task-snapshots:v1'
let snapshots: Map<number, string> | null = null

export function topologyTaskFingerprint(task: AdminPingTask): string {
  return JSON.stringify([task.id, task.name, task.type, task.target, [...task.clients].sort(), task.interval, Boolean(task.default_on)])
}

function readSnapshots(): Map<number, string> {
  if (snapshots)
    return snapshots
  snapshots = new Map()
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (Array.isArray(entry) && Number.isInteger(entry[0]) && entry[0] > 0 && typeof entry[1] === 'string')
          snapshots.set(entry[0], entry[1])
      }
    }
  }
  catch {}
  return snapshots
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...readSnapshots()]))
  }
  catch {
    // In-memory proof remains usable; after reload missing proof fails closed.
  }
}

/** Call only for a confirmed newly created task, never for a reused or reloaded ID. */
export function rememberCreatedTopologyTask(task: AdminPingTask): void {
  if (!Number.isInteger(task.id) || task.id! <= 0)
    return
  readSnapshots().set(task.id!, topologyTaskFingerprint(task))
  persist()
}

export function matchesCreatedTopologyTask(task: AdminPingTask): boolean {
  return readSnapshots().get(task.id!) === topologyTaskFingerprint(task)
}

export function forgetCreatedTopologyTask(id: number): void {
  readSnapshots().delete(id)
  persist()
}

export function resetTopologyTaskSnapshotsCache(): void {
  snapshots = null
}
