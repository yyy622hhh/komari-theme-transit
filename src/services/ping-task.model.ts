import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { findTopologyProbeKey, getTopologyProbeTarget, normalizePingTaskName, topologyEntryTaskName } from '@/utils/topologyPresets'

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

export type TopologyHopProbeType = 'icmp' | 'tcp'

export interface TopologyHopProbe {
  type: TopologyHopProbeType
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

function parsePort(value: string | undefined): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
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

export function topologyHopProbeFromTask(task: Pick<AdminPingTask, 'type' | 'target'>): TopologyHopProbe | null {
  const type = task.type.trim().toLowerCase()
  if (type === 'icmp')
    return DEFAULT_TOPOLOGY_HOP_PROBE
  if (type !== 'tcp')
    return null
  const port = pingTaskTargetPort(task.target)
  return port === null ? null : { type: 'tcp', port }
}

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

export function findTopologyPingTask(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  target: Pick<TopologyPingEndpoint, 'ipv4' | 'ipv6'>,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): AdminPingTask | undefined {
  const normalized = normalizeTopologyHopProbe(probe)
  return listTopologyPingTasks(tasks, sourceUuid, target).find((task) => {
    const taskProbe = topologyHopProbeFromTask(task)
    return taskProbe !== null && isSameTopologyHopProbe(taskProbe, normalized)
  })
}

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

function isSupportedEntryPingTask(task: Pick<AdminPingTask, 'type' | 'target'>): boolean {
  return SUPPORTED_PING_TASK_TYPES.has(task.type.trim().toLowerCase()) && Boolean(pingTaskTargetHost(task.target))
}

export function findPresetEntryTaskTemplate(tasks: readonly AdminPingTask[], probeKey: string): AdminPingTask | undefined {
  if (!probeKey.trim())
    return undefined
  const matches = tasks
    .filter(task => findTopologyProbeKey(task.name) === probeKey && isSupportedEntryPingTask(task))
    .sort((left, right) => (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER))
  if (!matches.length)
    return undefined
  const signature = (task: AdminPingTask) => `${task.type.trim().toLowerCase()}\0${task.target.trim()}`
  const first = matches[0]!
  if (matches.some(task => signature(task) !== signature(first)))
    return undefined
  return first
}

export function supportedPingTaskNames(tasks: readonly AdminPingTask[], nodeUuid: string): string[] {
  const names = tasks
    .filter(task => isPingTaskAssignedToSource(task, nodeUuid) && SUPPORTED_PING_TASK_TYPES.has(task.type.toLowerCase()))
    .map(task => task.name.trim())
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const name of names)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...new Set(names.filter(name => counts.get(name) === 1))]
}

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

export function topologyHopTaskNameCandidates(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): string[] {
  const plain = topologyHopTaskName(source, target, probe)
  const suffix = `-${target.uuid.slice(0, 8)}`
  return [...new Set([plain, `${plain.slice(0, 200 - suffix.length)}${suffix}`])]
}

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

export function findTopologyEntryProbeTask(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  probe: TopologyProbeOption,
  hopProbe: TopologyHopProbe,
  requestedName = '',
): AdminPingTask | undefined {
  const uniqueByName = (taskName: string) => {
    const matches = tasks.filter(task => isPingTaskAssignedToSource(task, sourceUuid) && task.name.trim() === taskName.trim())
    return matches.length === 1 ? matches[0] : undefined
  }
  if (requestedName)
    return uniqueByName(requestedName)
  const generated = uniqueByName(topologyEntryTaskName(probe, hopProbe))
  if (generated)
    return generated
  const canonicalNames = new Set([probe.taskFilter, probe.label].map(normalizePingTaskName))
  const canonical = tasks.filter(task => isPingTaskAssignedToSource(task, sourceUuid)
    && canonicalNames.has(normalizePingTaskName(task.name)))
  return canonical.length === 1 ? canonical[0] : undefined
}

export function buildTopologyEntryProbeDraft(
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  hopProbe: TopologyHopProbe,
  taskName: string,
): AdminPingTask {
  const targetHost = getTopologyProbeTarget(probe, hopProbe)
  if (!targetHost)
    throw new Error(`${probe.label}没有配置 ${describeTopologyHopProbe(hopProbe)} 探测目标，请手动创建并绑定任务。`)
  return {
    name: taskName,
    type: hopProbe.type,
    target: buildTopologyHopTarget({ ipv4: targetHost }, hopProbe),
    default_on: false,
    clients: [source.uuid],
    interval: 30,
  }
}
