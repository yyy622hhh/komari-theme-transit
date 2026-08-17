import { requirePermission, setAuthSessionFromLogin } from '@/services/auth.service'
import { invalidatePublicPingTasksCache } from '@/services/metrics.service'
import { requestManager } from '@/services/request.service'
import { getSharedRpc, isRpcPermissionError } from '@/utils/rpc'

export interface AdminPingTask {
  id?: number
  name: string
  clients: string[]
  default_on?: boolean
  type: 'icmp' | 'tcp' | 'http' | string
  target: string
  interval: number
  weight?: number
}

export interface TopologyPingEndpoint {
  uuid: string
  name: string
  ipv4?: string
  ipv6?: string
}

const ensureRequests = new Map<string, Promise<{ task: AdminPingTask, created: boolean }>>()
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
const STRIP_IP_BRACKETS_PATTERN = /^\[|\]$/g
const HTTP_TARGET_PATTERN = /^https?:\/\//i
const BRACKETED_TARGET_PATTERN = /^\[([^\]]+)\](?::\d+)?$/
const IPV4_PORT_PATTERN = /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/
const TASK_NAME_RESERVED_PATTERN = /[@;|]+/g
const WHITESPACE_PATTERN = /\s+/g
const SUPPORTED_PING_TASK_TYPES = new Set(['icmp', 'tcp', 'http'])

function validIpv4(value: string): boolean {
  if (!IPV4_PATTERN.test(value))
    return false
  return value.split('.').every(part => Number(part) <= 255)
}

function normalizeIp(value: string | undefined): string {
  const normalized = value?.trim().replace(STRIP_IP_BRACKETS_PATTERN, '') ?? ''
  if (validIpv4(normalized))
    return normalized
  if (normalized.includes(':')) {
    try {
      return new URL(`http://[${normalized}]/`).hostname.replace(STRIP_IP_BRACKETS_PATTERN, '').toLowerCase()
    }
    catch {
      return ''
    }
  }
  return ''
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted)
    return
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  throw error
}

async function withCrossTabPingLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    return task()
  return navigator.locks.request(`transit:topology-ping:${key}`, task)
}

function handlePingPermissionError(error: unknown): never {
  if (isRpcPermissionError(error)) {
    setAuthSessionFromLogin(false)
    throw new Error('登录状态已过期，请重新登录后管理 Ping 任务。')
  }
  throw error
}

export function topologyPingTargets(endpoint: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>): string[] {
  return [...new Set([normalizeIp(endpoint.ipv4), normalizeIp(endpoint.ipv6)].filter(Boolean))]
}

export function pingTaskTargetHost(target: string): string {
  const value = target.trim()
  if (!value)
    return ''
  if (HTTP_TARGET_PATTERN.test(value)) {
    try {
      return new URL(value).hostname.replace(STRIP_IP_BRACKETS_PATTERN, '').toLowerCase()
    }
    catch {
      return ''
    }
  }
  const bracketed = value.match(BRACKETED_TARGET_PATTERN)
  if (bracketed?.[1])
    return normalizeIp(bracketed[1])
  if (validIpv4(value))
    return value
  const ipv4WithPort = value.match(IPV4_PORT_PATTERN)
  if (ipv4WithPort?.[1] && validIpv4(ipv4WithPort[1]))
    return ipv4WithPort[1]
  return normalizeIp(value)
}

export function isPingTaskAssignedToSource(task: Pick<AdminPingTask, 'clients' | 'default_on'>, sourceUuid: string): boolean {
  return Boolean(sourceUuid.trim() && task.clients?.includes(sourceUuid))
}

export function findTopologyPingTask(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  target: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>,
): AdminPingTask | undefined {
  const targetHosts = new Set(topologyPingTargets(target))
  if (!sourceUuid.trim() || !targetHosts.size)
    return undefined
  const assignedTasks = tasks.filter(task => isPingTaskAssignedToSource(task, sourceUuid))
  return assignedTasks
    .filter(task => SUPPORTED_PING_TASK_TYPES.has(task.type.toLowerCase()) && targetHosts.has(pingTaskTargetHost(task.target)))
    .filter(candidate => assignedTasks.filter(task => task.name === candidate.name).length === 1)
    .sort((left, right) => Number(right.type === 'icmp') - Number(left.type === 'icmp')
      || (left.weight ?? Number.MAX_SAFE_INTEGER) - (right.weight ?? Number.MAX_SAFE_INTEGER)
      || (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER))[0]
}

async function assertPingTaskPermission(): Promise<void> {
  const permission = await requirePermission('advancedTools', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后管理 Ping 任务。')
}

async function fetchAdminPingTasks(signal?: AbortSignal): Promise<AdminPingTask[]> {
  try {
    return await requestManager.run('admin:ping:list', async (requestSignal) => {
      const tasks = await getSharedRpc().getAllPingTasks(requestSignal)
      return tasks.map(task => ({
        ...task,
        clients: Array.isArray(task.clients) ? task.clients : [],
        type: task.type ?? 'icmp',
        target: task.target ?? '',
      })) as AdminPingTask[]
    }, { retryAttempts: 0, signal })
  }
  catch (error) {
    handlePingPermissionError(error)
  }
}

export async function loadAdminPingTasks(): Promise<AdminPingTask[]> {
  await assertPingTaskPermission()
  return fetchAdminPingTasks()
}

export async function loadAdminPingTaskNamesForNode(nodeUuid: string): Promise<string[]> {
  if (!nodeUuid.trim())
    return []
  const tasks = await loadAdminPingTasks()
  const names = tasks
    .filter(task => isPingTaskAssignedToSource(task, nodeUuid) && SUPPORTED_PING_TASK_TYPES.has(task.type.toLowerCase()))
    .map(task => task.name.trim())
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const name of names)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...new Set(names.filter(name => counts.get(name) === 1))]
}

function safeTaskName(source: TopologyPingEndpoint, target: TopologyPingEndpoint, tasks: readonly AdminPingTask[]): string {
  const sanitize = (value: string) => value.trim().replace(TASK_NAME_RESERVED_PATTERN, '-').replace(WHITESPACE_PATTERN, '-')
  const base = `Transit-${sanitize(source.name)}-to-${sanitize(target.name)}`.slice(0, 180)
  if (!tasks.some(task => task.name === base))
    return base
  const suffix = `-${target.uuid.slice(0, 8)}`
  return `${base.slice(0, 200 - suffix.length)}${suffix}`
}

async function createTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  tasks: readonly AdminPingTask[],
  signal?: AbortSignal,
): Promise<void> {
  const pingTarget = topologyPingTargets(target)[0]
  if (!pingTarget)
    throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
  const body = {
    name: safeTaskName(source, target, tasks),
    type: 'icmp',
    target: pingTarget,
    default_on: false,
    clients: [source.uuid],
    interval: 30,
  }
  await requestManager.run(
    `admin:ping:add:${source.uuid}:${target.uuid}`,
    requestSignal => getSharedRpc().addPingTask(body, requestSignal),
    { retryAttempts: 0, signal },
  )
  invalidatePublicPingTasksCache()
}

export async function planTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
): Promise<{ task: AdminPingTask, needsCreation: boolean }> {
  if (!source.uuid.trim() || !target.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  const targets = topologyPingTargets(target)
  if (!targets.length)
    throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
  const tasks = await loadAdminPingTasks()
  const existing = findTopologyPingTask(tasks, source.uuid, target)
  if (existing)
    return { task: existing, needsCreation: false }
  return {
    task: {
      name: safeTaskName(source, target, tasks),
      type: 'icmp',
      target: targets[0]!,
      clients: [source.uuid],
      default_on: false,
      interval: 30,
    },
    needsCreation: true,
  }
}

export async function ensureTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  signal?: AbortSignal,
): Promise<{ task: AdminPingTask, created: boolean }> {
  const requestKey = `${source.uuid}:${target.uuid}:${topologyPingTargets(target).join(',')}`
  const pending = ensureRequests.get(requestKey)
  if (pending)
    return pending

  const request = withCrossTabPingLock(requestKey, async () => {
    throwIfAborted(signal)
    if (!source.uuid.trim() || !target.uuid.trim())
      throw new Error('线路机或落地机已失效，请重新选择。')
    if (!topologyPingTargets(target).length)
      throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
    await assertPingTaskPermission()
    throwIfAborted(signal)
    let tasks = await fetchAdminPingTasks(signal)
    const existing = findTopologyPingTask(tasks, source.uuid, target)
    if (existing)
      return { task: existing, created: false }

    try {
      throwIfAborted(signal)
      await createTopologyPingTask(source, target, tasks, signal)
    }
    catch (error) {
      if (signal?.aborted)
        throw error
      if (isRpcPermissionError(error))
        handlePingPermissionError(error)
      // A second tab may have created the same source/target task concurrently.
      tasks = await fetchAdminPingTasks(signal)
      const concurrent = findTopologyPingTask(tasks, source.uuid, target)
      if (concurrent)
        return { task: concurrent, created: false }
      throw error
    }

    throwIfAborted(signal)
    tasks = await fetchAdminPingTasks(signal)
    const created = findTopologyPingTask(tasks, source.uuid, target)
    if (!created)
      throw new Error('Ping 任务已提交，但服务器未返回对应任务，请稍后重试。')
    return { task: created, created: true }
  }).finally(() => ensureRequests.delete(requestKey))
  ensureRequests.set(requestKey, request)
  return request
}
