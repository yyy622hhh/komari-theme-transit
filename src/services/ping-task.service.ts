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

/** 第 2 段（线路机 → 落地机）可用的探测方式。 */
export type TopologyHopProbeType = 'icmp' | 'tcp'

export interface TopologyHopProbe {
  type: TopologyHopProbeType
  /** 仅 TCP 使用；ICMP 忽略。 */
  port?: number
}

export const DEFAULT_TOPOLOGY_HOP_PROBE: TopologyHopProbe = Object.freeze({ type: 'icmp' })

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
const STRIP_IP_BRACKETS_PATTERN = /^\[|\]$/g
const HTTP_TARGET_PATTERN = /^https?:\/\//i
const BRACKETED_TARGET_PATTERN = /^\[([^\]]+)\](?::\d+)?$/
const IPV4_PORT_PATTERN = /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/
const IPV4_TARGET_PORT_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}:(\d{1,5})$/
const BRACKETED_TARGET_PORT_PATTERN = /^\[[^\]]+\]:(\d{1,5})$/
const TASK_NAME_RESERVED_PATTERN = /[@;|]+/g
const WHITESPACE_PATTERN = /\s+/g
const SUPPORTED_PING_TASK_TYPES = new Set(['icmp', 'tcp', 'http'])
const TOPOLOGY_HOP_TASK_TYPES = new Set(['icmp', 'tcp'])
const DEFAULT_TOPOLOGY_TCP_PORT = 443

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

function parsePort(value: string | undefined): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

/** 读出 Ping 目标里的端口；没有端口（例如纯 ICMP 目标）返回 null。 */
export function pingTaskTargetPort(target: string): number | null {
  const value = target.trim()
  if (!value)
    return null
  if (HTTP_TARGET_PATTERN.test(value)) {
    try {
      return parsePort(new URL(value).port)
    }
    catch {
      return null
    }
  }
  return parsePort(value.match(BRACKETED_TARGET_PORT_PATTERN)?.[1] ?? value.match(IPV4_TARGET_PORT_PATTERN)?.[1])
}

export function normalizeTopologyHopProbe(probe?: TopologyHopProbe): TopologyHopProbe {
  if (probe?.type !== 'tcp')
    return DEFAULT_TOPOLOGY_HOP_PROBE
  return { type: 'tcp', port: parsePort(String(probe.port)) ?? DEFAULT_TOPOLOGY_TCP_PORT }
}

export function isSameTopologyHopProbe(left: TopologyHopProbe, right: TopologyHopProbe): boolean {
  const first = normalizeTopologyHopProbe(left)
  const second = normalizeTopologyHopProbe(right)
  return first.type === second.type && (first.type !== 'tcp' || first.port === second.port)
}

export function describeTopologyHopProbe(probe: TopologyHopProbe): string {
  const normalized = normalizeTopologyHopProbe(probe)
  return normalized.type === 'tcp' ? `TCP ${normalized.port}` : 'ICMP'
}

/** 从已存在的任务反推它属于哪种探测方式；无法用作拓扑第 2 段时返回 null。 */
export function topologyHopProbeFromTask(task: Pick<AdminPingTask, 'type' | 'target'>): TopologyHopProbe | null {
  const type = task.type.trim().toLowerCase()
  if (type === 'icmp')
    return DEFAULT_TOPOLOGY_HOP_PROBE
  if (type !== 'tcp')
    return null
  const port = pingTaskTargetPort(task.target)
  return port === null ? null : { type: 'tcp', port }
}

/** 按探测方式拼出 Ping 目标：ICMP 用裸地址，TCP 追加端口。 */
export function buildTopologyHopTarget(
  endpoint: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>,
  probe?: TopologyHopProbe,
): string {
  const host = topologyPingTargets(endpoint)[0]
  if (!host)
    return ''
  const normalized = normalizeTopologyHopProbe(probe)
  if (normalized.type !== 'tcp')
    return host
  return host.includes(':') ? `[${host}]:${normalized.port}` : `${host}:${normalized.port}`
}

export function isPingTaskAssignedToSource(task: Pick<AdminPingTask, 'clients' | 'default_on'>, sourceUuid: string): boolean {
  return Boolean(sourceUuid.trim() && task.clients?.includes(sourceUuid))
}

/**
 * 列出这台线路机上所有指向该落地机、可用作拓扑第 2 段的任务。
 *
 * 重名任务会被丢弃：渲染时只按任务名精确绑定，重名无法唯一定位。
 */
export function listTopologyPingTasks(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  target: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>,
): AdminPingTask[] {
  const targetHosts = new Set(topologyPingTargets(target))
  if (!sourceUuid.trim() || !targetHosts.size)
    return []
  const assignedTasks = tasks.filter(task => isPingTaskAssignedToSource(task, sourceUuid))
  return assignedTasks
    .filter(task => TOPOLOGY_HOP_TASK_TYPES.has(task.type.toLowerCase())
      && targetHosts.has(pingTaskTargetHost(task.target))
      && topologyHopProbeFromTask(task) !== null)
    .filter(candidate => assignedTasks.filter(task => task.name === candidate.name).length === 1)
    .sort((left, right) => (left.weight ?? Number.MAX_SAFE_INTEGER) - (right.weight ?? Number.MAX_SAFE_INTEGER)
      || (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER))
}

/** 找该线路机上按指定探测方式指向该落地机的任务；默认沿用历史的 ICMP。 */
export function findTopologyPingTask(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  target: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): AdminPingTask | undefined {
  const normalized = normalizeTopologyHopProbe(probe)
  return listTopologyPingTasks(tasks, sourceUuid, target)
    .find((task) => {
      const taskProbe = topologyHopProbeFromTask(task)
      return taskProbe !== null && isSameTopologyHopProbe(taskProbe, normalized)
    })
}

/**
 * 按任务名解析已绑定的第 2 段任务。
 *
 * 指标里只存任务名，所以重开对话框时必须先按名字认回来，否则自动挑选出的
 * 探测方式会被「按目标地址重新推导」的结果覆盖掉。
 */
export function findTopologyPingTaskByName(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  taskName: string,
): AdminPingTask | undefined {
  const name = taskName.trim()
  if (!sourceUuid.trim() || !name)
    return undefined
  const matches = tasks.filter(task => isPingTaskAssignedToSource(task, sourceUuid) && task.name.trim() === name)
  return matches.length === 1 ? matches[0] : undefined
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

/**
 * 生成第 2 段任务名。
 *
 * ICMP 保持历史命名 `Transit-<线路机>-to-<落地机>` 不变——改名会让已保存的
 * 线路（指标里只存任务名）失联。其它探测方式追加方式后缀，方便与 ICMP 并存。
 */
export function topologyHopTaskName(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
  tasks: readonly AdminPingTask[] = [],
): string {
  const sanitize = (value: string) => value.trim().replace(TASK_NAME_RESERVED_PATTERN, '-').replace(WHITESPACE_PATTERN, '-')
  const normalized = normalizeTopologyHopProbe(probe)
  const probeSuffix = normalized.type === 'tcp' ? `-tcp-${normalized.port}` : ''
  const base = `${`Transit-${sanitize(source.name)}-to-${sanitize(target.name)}`.slice(0, 180 - probeSuffix.length)}${probeSuffix}`
  if (!tasks.some(task => task.name === base))
    return base
  const suffix = `-${target.uuid.slice(0, 8)}`
  return `${base.slice(0, 200 - suffix.length)}${suffix}`
}

/**
 * 这一对线路机/落地机下，主题**自己**可能生成过的任务名。
 *
 * 用来判断一个任务是不是主题建的——只有主题建的才可以自动删掉，操作者手建的
 * 任务哪怕被复用过也绝不能碰。
 */
export function topologyHopTaskNameCandidates(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): string[] {
  const plain = topologyHopTaskName(source, target, probe)
  const suffix = `-${target.uuid.slice(0, 8)}`
  return [...new Set([plain, `${plain.slice(0, 200 - suffix.length)}${suffix}`])]
}

/**
 * 删除主题自己建的 Ping 任务。
 *
 * 删除只是清理，永远不能挡住主流程：老版本 Komari 没有这个 RPC，或者任务已被
 * 别人删掉，都当作没删成功处理。
 */
export async function deleteTopologyPingTasks(taskIds: readonly number[], signal?: AbortSignal): Promise<boolean> {
  const ids = [...new Set(taskIds.filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length)
    return false
  try {
    await requestManager.run(
      `admin:ping:delete:${ids.join(',')}`,
      requestSignal => getSharedRpc().deletePingTasks(ids, requestSignal),
      { retryAttempts: 0, signal },
    )
    invalidatePublicPingTasksCache()
    return true
  }
  catch {
    return false
  }
}

/** 按探测方式拼出待创建任务；不发请求，供计划阶段与创建阶段共用。 */
export function draftTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
  tasks: readonly AdminPingTask[] = [],
): AdminPingTask {
  const normalized = normalizeTopologyHopProbe(probe)
  const pingTarget = buildTopologyHopTarget(target, normalized)
  if (!pingTarget)
    throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
  return {
    name: topologyHopTaskName(source, target, normalized, tasks),
    type: normalized.type,
    target: pingTarget,
    default_on: false,
    clients: [source.uuid],
    interval: 30,
  }
}

async function createTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  tasks: readonly AdminPingTask[],
  probe: TopologyHopProbe,
  signal?: AbortSignal,
): Promise<void> {
  const draft = draftTopologyPingTask(source, target, probe, tasks)
  const body = { ...draft, default_on: draft.default_on ?? false }
  await requestManager.run(
    `admin:ping:add:${source.uuid}:${target.uuid}:${describeTopologyHopProbe(probe)}`,
    requestSignal => getSharedRpc().addPingTask(body, requestSignal),
    { retryAttempts: 0, signal },
  )
  invalidatePublicPingTasksCache()
}

export async function planTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): Promise<{ task: AdminPingTask, needsCreation: boolean }> {
  if (!source.uuid.trim() || !target.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  if (!topologyPingTargets(target).length)
    throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
  const tasks = await loadAdminPingTasks()
  const existing = findTopologyPingTask(tasks, source.uuid, target, probe)
  if (existing)
    return { task: existing, needsCreation: false }
  return { task: draftTopologyPingTask(source, target, probe, tasks), needsCreation: true }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function ensureTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  options: { probe?: TopologyHopProbe, signal?: AbortSignal } = {},
): Promise<{ task: AdminPingTask, created: boolean }> {
  const { signal } = options
  const probe = normalizeTopologyHopProbe(options.probe)
  throwIfAborted(signal)
  const requestKey = `${source.uuid}:${target.uuid}:${topologyPingTargets(target).join(',')}:${describeTopologyHopProbe(probe)}`
  return withCrossTabPingLock(requestKey, async () => {
    if (!source.uuid.trim() || !target.uuid.trim())
      throw new Error('线路机或落地机已失效，请重新选择。')
    if (!topologyPingTargets(target).length)
      throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
    throwIfAborted(signal)
    await assertPingTaskPermission()
    throwIfAborted(signal)
    let tasks = await fetchAdminPingTasks(signal)
    const existing = findTopologyPingTask(tasks, source.uuid, target, probe)
    if (existing)
      return { task: existing, created: false }

    try {
      await createTopologyPingTask(source, target, tasks, probe, signal)
    }
    catch (error) {
      if (signal?.aborted || isAbortError(error))
        throw error
      if (isRpcPermissionError(error))
        handlePingPermissionError(error)
      // A second tab may have created the same source/target task concurrently.
      tasks = await fetchAdminPingTasks(signal)
      const concurrent = findTopologyPingTask(tasks, source.uuid, target, probe)
      if (concurrent)
        return { task: concurrent, created: false }
      throw error
    }

    tasks = await fetchAdminPingTasks(signal)
    const created = findTopologyPingTask(tasks, source.uuid, target, probe)
    if (!created)
      throw new Error('Ping 任务已提交，但服务器未返回对应任务，请稍后重试。')
    return { task: created, created: true }
  })
}
