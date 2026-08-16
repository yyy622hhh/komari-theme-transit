import type { NodeData } from '@/stores/nodes'
import type { AdminPingTask, CreatePingTaskResponse } from '@/utils/rpc'
import { invalidatePublicPingTasks } from '@/services/metrics.service'
import { requestManager } from '@/services/request.service'
import { getSharedRpc } from '@/utils/rpc'

export interface TopologyTaskCreationResult extends CreatePingTaskResponse {
  name: string
}

export interface TopologyTaskEnsureResult extends TopologyTaskCreationResult {
  created: boolean
}

const TOPOLOGY_TASK_INTERVAL_SECONDS = 30
const TOPOLOGY_TASK_TYPE = 'icmp'
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]/gi

function targetAddress(target: Pick<NodeData, 'ipv4' | 'ipv6'>): string {
  return target.ipv4?.trim() || target.ipv6?.trim() || ''
}

function legacyTopologyPingTaskName(source: Pick<NodeData, 'name'>, target: Pick<NodeData, 'name'>): string {
  return `Transit-${source.name.trim()}-to-${target.name.trim()}`
}

function shortNodeIdentity(node: Pick<NodeData, 'uuid'>): string {
  return node.uuid.replace(NON_ALPHANUMERIC_PATTERN, '').slice(-8) || 'unknown'
}

function taskFingerprint(source: Pick<NodeData, 'uuid'>, target: Pick<NodeData, 'uuid'>, address: string): string {
  let hash = 2166136261
  for (const character of `${source.uuid}\u0000${target.uuid}\u0000${address}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** A stable, collision-resistant name that still remains readable in Komari. */
export function topologyPingTaskName(
  source: Pick<NodeData, 'name' | 'uuid'>,
  target: Pick<NodeData, 'name' | 'uuid' | 'ipv4' | 'ipv6'>,
): string {
  const address = targetAddress(target)
  const suffix = ` [${shortNodeIdentity(source)}-${shortNodeIdentity(target)}-${taskFingerprint(source, target, address)}]`
  const prefix = 'Transit-'
  const readableLength = Math.max(1, 255 - prefix.length - suffix.length)
  return `${prefix}${`${source.name.trim()}-to-${target.name.trim()}`.slice(0, readableLength)}${suffix}`
}

function assertDistinctTopologyNodes(source: NodeData, target: NodeData): string {
  if (source.uuid === target.uuid)
    throw new Error('线路机和落地机不能是同一台节点。')
  if (!source.uuid.trim())
    throw new Error('线路机没有有效的 Komari 节点标识。')

  const address = targetAddress(target)
  if (!address)
    throw new Error(`落地机“${target.name}”没有公网 IP，无法自动创建任务。`)
  return address
}

function isExactTopologyTask(task: AdminPingTask, source: NodeData, target: NodeData): boolean {
  const expectedNames = new Set([
    topologyPingTaskName(source, target),
    legacyTopologyPingTaskName(source, target),
  ])
  return expectedNames.has(task.name.trim())
    && task.target.trim() === targetAddress(target)
    && task.type === TOPOLOGY_TASK_TYPE
    && task.interval === TOPOLOGY_TASK_INTERVAL_SECONDS
    && task.default_on === false
    && task.clients.includes(source.uuid)
}

async function findExactTopologyTask(source: NodeData, target: NodeData): Promise<AdminPingTask | null> {
  assertDistinctTopologyNodes(source, target)
  const tasks = await requestManager.run(
    'topology:ping-task-list',
    signal => getSharedRpc().getAllPingTasks(signal),
    { retryAttempts: 0 },
  )
  return tasks.find(task => isExactTopologyTask(task, source, target)) ?? null
}

async function withTopologyTaskLock<T>(source: NodeData, target: NodeData, operation: () => Promise<T>): Promise<T> {
  const lockName = `transit:topology-ping:${source.uuid}:${target.uuid}`
  if (typeof navigator === 'undefined' || !navigator.locks)
    return operation()
  return navigator.locks.request(lockName, { mode: 'exclusive' }, operation)
}

/**
 * Creates the only live hop required by the simple topology form.
 *
 * ICMP is used because the theme knows each node's public IP, but not a
 * reliable TCP service port. This makes the generated task usable without
 * another configuration screen.
 */
export async function createTopologyPingTask(source: NodeData, target: NodeData): Promise<TopologyTaskCreationResult> {
  const name = topologyPingTaskName(source, target)
  const targetIp = assertDistinctTopologyNodes(source, target)

  try {
    const task = await requestManager.run(
      `topology:ping-task:${source.uuid}:${target.uuid}:${name}`,
      signal => getSharedRpc().createPingTask({
        clients: [source.uuid],
        default_on: false,
        name,
        target: targetIp,
        type: TOPOLOGY_TASK_TYPE,
        interval: TOPOLOGY_TASK_INTERVAL_SECONDS,
      }, signal),
      // Retrying a timed-out create could make duplicate Ping tasks.
      { retryAttempts: 0 },
    )
    return { ...task, name }
  }
  finally {
    // A timeout can still reach Komari after the browser gives up. Never let
    // a retry use the one-minute public task cache in that ambiguous state.
    invalidatePublicPingTasks()
  }
}

/**
 * Under a per-route browser lock, atomically re-check and then create the
 * generated task. The exact admin list includes target/type fields that the
 * public list intentionally omits, so a stale or similarly named task is
 * never rebound to another destination.
 */
export async function ensureTopologyPingTask(source: NodeData, target: NodeData): Promise<TopologyTaskEnsureResult> {
  assertDistinctTopologyNodes(source, target)
  return withTopologyTaskLock(source, target, async () => {
    const existing = await findExactTopologyTask(source, target)
    if (existing)
      return { task_id: existing.id, name: existing.name, created: false }

    const created = await createTopologyPingTask(source, target)
    return { ...created, created: true }
  })
}
