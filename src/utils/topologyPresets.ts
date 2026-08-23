import { TOPOLOGY_METRIC_RESERVED_PATTERN } from '@/utils/topologyModel'

/**
 * 九个入口预设，以及「一个任务名到底属于哪个预设」的全部判断。
 *
 * 这里是任务名匹配的唯一真相：预设有 `taskFilter`（惯用任务名）和 `label`
 * （界面显示名）两个名字，广州三条的两者并不相同，任何按名字认预设的地方都
 * 必须认全套别名，否则「识别成预设」和「取到任务」两步会得出相反结论。
 */

export interface TopologyProbeOption {
  key: string
  city: string
  carrier: string
  label: string
  taskFilter: string
  /**
   * ICMP 探测目标：该运营商在该城市的骨干网关。取自 zhanghanyun/backtrace
   * （社区广泛使用的三网回程路由测试工具，多个衍生工具直接引用同一份地址表）
   * 内置的测试点，而不是随手挑的地址。即便如此，线路机主动 ping 这个地址得到
   * 的仍然是「线路机到该地址」的连通质量，方向和「该运营商用户访问线路机」
   * 是相反的，不能等价。
   */
  landmarkAddress: string
  /**
   * TCP 探测目标：该运营商在该城市的公共 DNS 解析器。
   *
   * ICMP 被墙时需要换一种探测方式，但骨干网关不接任何 TCP 端口，拿它做 TCP
   * 探测必然判死。解析器同属这家运营商同一座城市，链路意义一致，而且 DNS over
   * TCP（53）是它真正会应答的端口。
   */
  dnsAddress: string
  /** 每种探测方式各自的目标地址；没有配置的档位表示这个预设不支持该方式。 */
  probeTargets: {
    icmp?: string
    tcp?: Partial<Record<number, string>>
  }
}

const TOPOLOGY_PROBE_SEPARATOR_PATTERN = /[\s\-_—–·]+/g
const TOPOLOGY_PROBE_TARGET_FORBIDDEN_PATTERN = /[\s/@?#]/

function defineTopologyProbe(option: Omit<TopologyProbeOption, 'probeTargets'>): TopologyProbeOption {
  return {
    ...option,
    probeTargets: {
      icmp: option.landmarkAddress,
      // 只开 53：见 `OPS_TOPOLOGY_ENTRY_PROBE_LADDER` 为什么入口不走 443/80/22。
      tcp: { 53: option.dnsAddress },
    },
  }
}

export const TOPOLOGY_PROBE_OPTIONS: TopologyProbeOption[] = [
  defineTopologyProbe({ key: 'beijing-telecom', city: '北京', carrier: '电信', label: '北京电信', taskFilter: '北京电信', landmarkAddress: '219.141.140.10', dnsAddress: '219.141.136.10' }),
  defineTopologyProbe({ key: 'beijing-unicom', city: '北京', carrier: '联通', label: '北京联通', taskFilter: '北京联通', landmarkAddress: '202.106.195.68', dnsAddress: '202.106.0.20' }),
  defineTopologyProbe({ key: 'beijing-mobile', city: '北京', carrier: '移动', label: '北京移动', taskFilter: '北京移动', landmarkAddress: '221.179.155.161', dnsAddress: '221.130.33.52' }),
  defineTopologyProbe({ key: 'shanghai-telecom', city: '上海', carrier: '电信', label: '上海电信', taskFilter: '上海电信', landmarkAddress: '202.96.209.133', dnsAddress: '202.96.209.133' }),
  defineTopologyProbe({ key: 'shanghai-unicom', city: '上海', carrier: '联通', label: '上海联通', taskFilter: '上海联通', landmarkAddress: '210.22.97.1', dnsAddress: '210.22.70.3' }),
  defineTopologyProbe({ key: 'shanghai-mobile', city: '上海', carrier: '移动', label: '上海移动', taskFilter: '上海移动', landmarkAddress: '211.136.112.200', dnsAddress: '211.136.112.50' }),
  defineTopologyProbe({ key: 'guangzhou-telecom', city: '广州', carrier: '电信', label: '广州电信', taskFilter: '广东电信', landmarkAddress: '58.60.188.222', dnsAddress: '202.96.128.86' }),
  defineTopologyProbe({ key: 'guangzhou-unicom', city: '广州', carrier: '联通', label: '广州联通', taskFilter: '广东联通', landmarkAddress: '210.21.196.6', dnsAddress: '210.21.196.6' }),
  defineTopologyProbe({ key: 'guangzhou-mobile', city: '广州', carrier: '移动', label: '广州移动', taskFilter: '广东移动', landmarkAddress: '120.196.165.24', dnsAddress: '211.136.192.6' }),
]

export function normalizePingTaskName(value: string): string {
  return value.toLowerCase().replace(TOPOLOGY_PROBE_SEPARATOR_PATTERN, '')
}

/** 只接受裸 IP/主机名，拒绝 URL、端口、路径和空白，避免把不透明字符串写进任务。 */
export function normalizeTopologyProbeTarget(value: string): string {
  const target = value.trim()
  if (!target || target.length > 253 || TOPOLOGY_PROBE_TARGET_FORBIDDEN_PATTERN.test(target))
    return ''
  const unwrapped = /^\[([^\]]+)\]$/.exec(target)?.[1] ?? target
  try {
    const hostname = new URL(`http://${unwrapped.includes(':') ? `[${unwrapped}]` : unwrapped}/`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return hostname && hostname.length <= 253 ? hostname : ''
  }
  catch {
    return ''
  }
}

function stableProbeHash(value: string): string {
  let hash = 0x811C9DC5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 把“名称 + 目标”变成与内置预设同构的运行时入口，不扩大全局预设表。 */
export function createCustomTopologyProbe(labelValue: string, targetValue: string): TopologyProbeOption | null {
  const label = labelValue.trim()
  const target = normalizeTopologyProbeTarget(targetValue)
  if (!label || !target)
    return null
  // 显示名称不是探测任务的身份。只改“湖北电信”这类标题时应继续复用原任务，
  // 否则每次改名都会留下一个无人绑定的 Transit-entry-* 任务。
  const hash = stableProbeHash(target)
  const key = `custom-${hash}`
  return {
    key,
    city: '自定义',
    carrier: '',
    label,
    taskFilter: `Transit-entry-${key}`,
    landmarkAddress: target,
    dnsAddress: target,
    // 自定义地址不一定是 DNS 服务器，不能像内置运营商预设那样盲探 TCP 53。
    // ICMP 被屏蔽时改试服务器最常见的公开端口。
    probeTargets: { icmp: target, tcp: { 443: target, 80: target, 22: target } },
  }
}

export function isCustomTopologyProbe(option: Pick<TopologyProbeOption, 'key'>): boolean {
  return option.key.startsWith('custom-')
}

export function getTopologyProbe(key?: string): TopologyProbeOption {
  return TOPOLOGY_PROBE_OPTIONS.find(option => option.key === key) ?? TOPOLOGY_PROBE_OPTIONS[0]!
}

/**
 * 一个预设探测可以由两个名字指代：`taskFilter` 是 Ping 任务的实际命名，`label`
 * 是界面上的显示名。广州三条预设的两者并不相同（`广州电信` / `广东电信`），所以
 * 任何按名字认预设的地方都必须认全套别名，否则识别与取任务两步会得出相反结论。
 */
function topologyProbeAliases(option: TopologyProbeOption): string[] {
  return [normalizePingTaskName(option.taskFilter), normalizePingTaskName(option.label)].filter(Boolean)
}

export function getTopologyProbeTarget(
  option: TopologyProbeOption,
  probe: { type: string, port?: number },
): string {
  if (probe.type === 'icmp')
    return option.probeTargets.icmp?.trim() ?? ''
  if (probe.type !== 'tcp' || !Number.isInteger(probe.port))
    return ''
  return option.probeTargets.tcp?.[probe.port!]?.trim() ?? ''
}

export function topologyEntryTaskName(
  option: TopologyProbeOption,
  probe: { type: string, port?: number },
): string {
  const suffix = probe.type === 'tcp' && Number.isInteger(probe.port)
    ? `tcp-${probe.port}`
    : 'icmp'
  return `Transit-entry-${option.key}-${suffix}`
}

function isTopologyEntryTaskName(value: string, option: TopologyProbeOption): boolean {
  const normalized = normalizePingTaskName(value)
  const prefix = normalizePingTaskName(`Transit-entry-${option.key}-`)
  return normalized === `${prefix}icmp` || new RegExp(`^${prefix}tcp\\d+$`).test(normalized)
}

export function findTopologyProbeKey(...values: string[]): string | undefined {
  const normalizedValues = values.map(normalizePingTaskName).filter(Boolean)
  // 别名之外还要认旧版 Transit-entry-* 命名：早先的入口任务是那么建的，
  // 换名后仍要能识别回同一个预设，否则会被当成陌生任务重新建一遍。
  return TOPOLOGY_PROBE_OPTIONS.find(option => normalizedValues.some(value =>
    topologyProbeAliases(option).includes(value) || isTopologyEntryTaskName(value, option),
  ))?.key
}

export function listTopologyProbeTaskNamesForSource(
  tasks: readonly { name: string, clients?: readonly string[] }[],
  sourceUuid: string,
): string[] {
  const namesOf = (list: readonly { name: string }[]) => list
    .map(task => task.name.trim())
    .filter(Boolean)
  const uuid = sourceUuid.trim()
  const hasClientLists = tasks.some(task => Array.isArray(task.clients))
  if (uuid && hasClientLists)
    return namesOf(tasks.filter(task => task.clients?.includes(uuid)))
  return namesOf(tasks)
}

export function resolveTopologyProbeTaskName(
  probeKey: string,
  taskNames: readonly string[] = [],
  configuredTaskFilter = '',
): string {
  const probe = getTopologyProbe(probeKey)
  const uniqueTask = pickQuickTopologyTaskName(taskNames, probe)
  if (uniqueTask)
    return uniqueTask
  const configured = configuredTaskFilter.trim()
  if (configured && findTopologyProbeKey(configured) === probe.key)
    return configured
  return probe.taskFilter
}

export function findQuickTopologyTaskProbe(taskNames: readonly string[]): TopologyProbeOption | null {
  for (const taskName of taskNames) {
    const probeKey = findTopologyProbeKey(taskName.trim())
    if (probeKey)
      return getTopologyProbe(probeKey)
  }
  return null
}

export function normalizeQuickTopologyTaskNames(taskNames: readonly string[]): string[] {
  return taskNames
    .map(task => task.trim())
    .filter(task => task && !TOPOLOGY_METRIC_RESERVED_PATTERN.test(task))
}

export function pickQuickTopologyTaskName(taskNames: readonly string[], probe: TopologyProbeOption = getTopologyProbe('')): string {
  // 广州的三网任务惯用名是「广东电信/联通/移动」（taskFilter），但入口下拉显示
  // 的是「广州电信」（label），两个都要认。
  const aliases = topologyProbeAliases(probe)
  const normalizedTasks = normalizeQuickTopologyTaskNames(taskNames)
  const matches = normalizedTasks.filter(task => aliases.includes(normalizePingTaskName(task)))

  return matches.length === 1 ? matches[0]! : ''
}
