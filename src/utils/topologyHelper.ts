import type { TopologyNodeConfig, TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { formatCityNameZh } from '@/utils/cityNameHelper'
import { createTopologyRoute, TOPOLOGY_LIMITS, TOPOLOGY_METRIC_RESERVED_PATTERN, TOPOLOGY_NODE_RESERVED_PATTERN } from '@/utils/topologyModel'
import { findQuickTopologyTaskProbe, findTopologyProbeKey, getTopologyProbe, normalizePingTaskName, normalizeQuickTopologyTaskNames, pickQuickTopologyTaskName } from '@/utils/topologyPresets'

// 拓扑模型的类型在这里再导出一次：调用方谈的是「拓扑」，不该被迫记住类型定义
// 落在哪个内部文件。值和函数不转发，避免这里退化成一个什么都能拿到的桶。
export type { TopologyMetricConfig, TopologyNodeConfig, TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
export type { TopologyProbeOption } from '@/utils/topologyPresets'

const CJK_UNIFIED_IDEOGRAPH_REGEX = /\p{Script=Han}/u

function quickNodeRank(node: TopologyQuickNode): number {
  if (node.online === true)
    return 0
  if (node.online === false)
    return 2
  return 1
}

/**
 * 新建线路时可选的候选节点。
 *
 * 排除离线节点是有意的：快速添加会当场规划并验证探测，离线节点给不出任何采样。
 * 编辑已有线路的下拉走的是全量节点列表（离线的会标注「离线」），这样节点掉线后
 * 仍然可以修线路。
 */
export function listQuickTopologyNodes<T extends TopologyQuickNode>(nodes: readonly T[]): T[] {
  const nameCounts = new Map<string, number>()
  for (const node of nodes) {
    const name = node.name.trim().toLowerCase()
    if (name)
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }

  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name.trim()
      && node.online !== false
      && (Boolean(node.uuid?.trim()) || nameCounts.get(node.name.trim().toLowerCase()) === 1)
      && !TOPOLOGY_NODE_RESERVED_PATTERN.test(node.name)
      && !TOPOLOGY_NODE_RESERVED_PATTERN.test(node.region ?? ''))
    .sort((left, right) => quickNodeRank(left.node) - quickNodeRank(right.node) || left.index - right.index)
    .map(({ node }) => node)
}

export function getQuickTopologySourceNode<T extends TopologyQuickNode>(nodes: readonly T[]): T | null {
  return listQuickTopologyNodes(nodes)[0] ?? null
}

export function findUniqueTopologyNode<T extends Pick<TopologyQuickNode, 'name'>>(nodes: readonly T[], name: string): T | undefined {
  const normalized = name.trim().toLowerCase()
  if (!normalized)
    return undefined
  const matches = nodes.filter(node => node.name.trim().toLowerCase() === normalized)
  return matches.length === 1 ? matches[0] : undefined
}

export function resolveTopologyNode<T extends TopologyQuickNode>(
  nodes: readonly T[],
  name: string,
  uuid = '',
): T | undefined {
  const id = uuid.trim()
  if (id) {
    const matches = nodes.filter(node => node.uuid?.trim() === id)
    if (matches.length === 1)
      return matches[0]
  }
  return findUniqueTopologyNode(nodes, name)
}

/**
 * 实时探测来源以指标里的节点名为准。线路机 UUID 只在名字对得上时用来消歧；
 * 入口段可以把探测放到另一台机器上（例如离线的外部来源），不能被线路机 UUID 盖掉。
 */
export function resolveTopologyMetricSource<T extends TopologyQuickNode>(
  nodes: readonly T[],
  nodeName: string,
  uuid = '',
): T | undefined {
  const named = nodeName.trim()
  const id = uuid.trim()
  if (id) {
    const matches = nodes.filter(node => node.uuid?.trim() === id)
    if (matches.length === 1 && (!named || matches[0]!.name.trim() === named))
      return matches[0]
  }
  return findUniqueTopologyNode(nodes, named)
}

/** 只给线路机/落地机补 UUID；入口是探测标签，不能误绑到同名节点。 */
export function hydrateTopologyRouteNodes(
  routes: TopologyRouteConfig[],
  nodes: readonly TopologyQuickNode[],
): void {
  for (const route of routes) {
    route.nodes.forEach((config, index) => {
      if (index === 0)
        return
      const resolved = resolveTopologyNode(nodes, config.name, config.uuid)
      if (!resolved?.uuid)
        return
      config.uuid = resolved.uuid
      config.name = resolved.name.trim()
      if (resolved.region?.trim())
        config.region = resolved.region.trim()
    })
  }
}

function makeUniqueQuickEntryLabel(label: string, configuredNames: Set<string>): string {
  const trimmedLabel = label.trim() || '自定义入口'
  const normalizeNodeName = (name: string) => name.trim().toLowerCase()
  if (!configuredNames.has(normalizeNodeName(trimmedLabel)))
    return trimmedLabel

  const suffixedLabel = `${trimmedLabel}入口`
  if (!configuredNames.has(normalizeNodeName(suffixedLabel)))
    return suffixedLabel

  let index = 2
  while (configuredNames.has(normalizeNodeName(`${suffixedLabel}${index}`)))
    index += 1
  return `${suffixedLabel}${index}`
}

function namesLooselyMatch(left: string, right: string): boolean {
  if (!left || !right)
    return false
  if (left === right)
    return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (CJK_UNIFIED_IDEOGRAPH_REGEX.test(shorter))
    return shorter.length >= 3 ? longer.includes(shorter) : shorter.length === 2 && longer.startsWith(shorter)
  return shorter.length >= 4 && longer.includes(shorter)
}

function hopMatchAliases(value: string): string[] {
  const aliases = new Set<string>()
  const normalized = normalizePingTaskName(value)
  if (normalized)
    aliases.add(normalized)
  const cityZh = formatCityNameZh(value)
  if (cityZh)
    aliases.add(normalizePingTaskName(cityZh))
  return [...aliases]
}

export function pickQuickHopTaskName(
  taskNames: readonly string[],
  targetName: string,
  excludeTask = '',
): string {
  const excluded = normalizePingTaskName(excludeTask)
  const targetAliases = hopMatchAliases(targetName)
  if (!targetAliases.length)
    return ''

  const usable = normalizeQuickTopologyTaskNames(taskNames)
    .filter(task => normalizePingTaskName(task) !== excluded)

  return usable.find(task => hopMatchAliases(task).some(alias => targetAliases.includes(alias)))
    ?? usable.find(task => hopMatchAliases(task).some(alias => targetAliases.some(target => namesLooselyMatch(alias, target))))
    ?? ''
}

export interface QuickTopologyRouteOptions {
  sourceUuid?: string
  landingUuid?: string | null
  sourceTasks?: readonly string[]
  entryTask?: string
  hopTask?: string
  probeKey?: string
}

const QUICK_ENTRY_COLLISION_SUFFIX_PATTERN = /^(.*)入口\d*$/

/**
 * `makeUniqueQuickEntryLabel` 撞到同名节点时会把入口标签改成「<预设名>入口」
 * 或「<预设名>入口<N>」。这里的候选列表把后缀去掉，让探测键识别在撞名之后
 * 依然成立——否则一旦某台节点恰好叫「北京电信」，该预设入口在没有匹配任务
 * 时会被永久当成自定义入口：`shouldAutoApplyTopologyProbe` 从此再也不会重新
 * 尝试匹配，哪怕之后在 Komari 里补建了同名任务。
 */
function quickEntryLabelCandidates(label: string): string[] {
  const trimmed = label.trim()
  const match = QUICK_ENTRY_COLLISION_SUFFIX_PATTERN.exec(trimmed)
  return match?.[1] ? [trimmed, match[1]] : [trimmed]
}

export function getTopologyRouteProbeKey(route: Pick<TopologyRouteConfig, 'nodes' | 'metrics'>): string {
  return findTopologyProbeKey(
    ...quickEntryLabelCandidates(route.nodes[0]?.name ?? ''),
    route.metrics[0]?.taskFilter ?? '',
  ) ?? ''
}

export function shouldAutoApplyTopologyProbe(route: Pick<TopologyRouteConfig, 'nodes' | 'metrics'>): boolean {
  const firstTask = route.metrics[0]?.taskFilter.trim() ?? ''
  if (!firstTask)
    return Boolean(findTopologyProbeKey(...quickEntryLabelCandidates(route.nodes[0]?.name ?? '')))
  return Boolean(findTopologyProbeKey(firstTask))
}

export function applyTopologyProbeToRoute(
  route: TopologyRouteConfig,
  probeKey: string,
  sourceName: string,
  taskNames: readonly string[] = [],
  reservedNodeNames: readonly string[] = [],
): TopologyProbeOption {
  const probe = getTopologyProbe(probeKey)
  const reserved = new Set(
    reservedNodeNames
      .map(name => name.trim().toLowerCase())
      .filter(name => name && name !== route.nodes[0]?.name.trim().toLowerCase()),
  )
  const entryTask = pickQuickTopologyTaskName(taskNames, probe)
  const entry = route.nodes[0] ?? { name: '', region: 'CN', role: '入口' }
  entry.name = makeUniqueQuickEntryLabel(probe.label, reserved)
  entry.region = 'CN'
  entry.role = '入口'
  route.nodes[0] = entry
  const first = route.metrics[0] ?? {
    live: false,
    nodeName: '',
    taskFilter: '',
    fallbackLatency: null,
    fallbackLoss: null,
  }
  // 取不到唯一任务时不要擦掉一条已经指向同一个预设的实时绑定：调用方
  // (`rematchOpenRoutes`) 会立刻把结果写回服务端，擦掉即不可逆。只有当既有绑定
  // 属于别的预设时才让位——那是操作员主动换了预设，覆盖才是预期行为。
  const keepsExistingBinding
    = !entryTask
      && first.live
      && Boolean(first.taskFilter.trim())
      && findTopologyProbeKey(first.taskFilter) === probe.key

  route.metrics[0] = keepsExistingBinding
    ? { ...first }
    : {
        ...first,
        live: Boolean(entryTask),
        nodeName: entryTask ? sourceName.trim() : '',
        taskFilter: entryTask,
      }
  return probe
}

export function nextQuickLandingUuid(
  sourceUuid: string,
  selectedLandingUuid: string,
  candidateUuids: readonly string[],
  initialize = false,
  unusedLandingUuids: readonly string[] = [],
): string {
  const landings = candidateUuids.filter(uuid => uuid && uuid !== sourceUuid)
  const preferred = unusedLandingUuids.filter(uuid => landings.includes(uuid))
  if (!selectedLandingUuid)
    return initialize ? (preferred[0] ?? landings[0] ?? '') : ''
  if (landings.includes(selectedLandingUuid))
    return selectedLandingUuid
  return preferred[0] ?? landings[0] ?? ''
}

function topologyEndpointKey(node?: Pick<TopologyNodeConfig, 'name' | 'uuid'>): string {
  return node?.uuid?.trim() || node?.name.trim().toLowerCase() || ''
}

function isSameTopologyEndpoint(
  node: Pick<TopologyNodeConfig, 'name' | 'uuid'> | undefined,
  name: string,
  uuid = '',
): boolean {
  if (!node)
    return !name.trim() && !uuid.trim()
  if (uuid.trim() && node.uuid?.trim())
    return node.uuid === uuid.trim()
  return node.name.trim().toLowerCase() === name.trim().toLowerCase()
}

export function getTopologyRouteEndpoints(route: Pick<TopologyRouteConfig, 'nodes'>): { source: string, landing: string } {
  return {
    source: topologyEndpointKey(route.nodes[1]),
    landing: topologyEndpointKey(route.nodes[2]),
  }
}

export function findDuplicateTopologyRouteIndex(
  routes: readonly Pick<TopologyRouteConfig, 'nodes'>[],
  sourceName: string,
  landingName = '',
  sourceUuid = '',
  landingUuid = '',
): number {
  if (!sourceUuid.trim() && !sourceName.trim())
    return -1
  return routes.findIndex(route => isSameTopologyEndpoint(route.nodes[1], sourceName, sourceUuid)
    && isSameTopologyEndpoint(route.nodes[2], landingName, landingUuid))
}

export function listUnusedQuickLandingUuids(
  routes: readonly Pick<TopologyRouteConfig, 'nodes'>[],
  sourceName: string,
  candidates: readonly TopologyQuickNode[],
  sourceUuid = '',
): string[] {
  return candidates.flatMap((node) => {
    const uuid = node.uuid?.trim()
    if (!uuid || uuid === sourceUuid)
      return []
    return findDuplicateTopologyRouteIndex(routes, sourceName, node.name, sourceUuid, uuid) < 0 ? [uuid] : []
  })
}

function isQuickTopologyRouteOptions(value: unknown): value is QuickTopologyRouteOptions {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveQuickTopologyLanding<T extends TopologyQuickNode>(
  candidates: readonly T[],
  source: T,
  landingUuid?: string | null,
): T | undefined | null {
  if (landingUuid === null || landingUuid === '')
    return undefined

  if (typeof landingUuid === 'string') {
    const landing = candidates.find(node => node.uuid === landingUuid)
    if (!landing || landing === source)
      return null
    return landing
  }

  const sourceName = source.name.trim().toLowerCase()
  return candidates.find(node => node !== source && node.name.trim().toLowerCase() !== sourceName)
}

export function buildQuickTopologyRoute(
  nodes: readonly TopologyQuickNode[],
  taskNamesOrOptions: readonly string[] | QuickTopologyRouteOptions = [],
  sourceUuid = '',
): TopologyRouteConfig | null {
  const options = isQuickTopologyRouteOptions(taskNamesOrOptions)
    ? taskNamesOrOptions
    : { sourceTasks: taskNamesOrOptions, sourceUuid }
  const candidates = listQuickTopologyNodes(nodes)
  const source = options.sourceUuid
    ? candidates.find(node => node.uuid === options.sourceUuid)
    : candidates[0]
  if (!source)
    return null

  const landing = resolveQuickTopologyLanding(candidates, source, options.landingUuid)
  if (landing === null)
    return null

  const configuredNames = new Set(candidates.map(node => node.name.trim().toLowerCase()))
  const usableTaskNames = normalizeQuickTopologyTaskNames(options.sourceTasks ?? [])
  const requestedProbe = options.probeKey ? getTopologyProbe(options.probeKey) : null
  const autoProbe = requestedProbe ?? findQuickTopologyTaskProbe(usableTaskNames)
  const explicitEntryTask = options.entryTask === undefined
    ? undefined
    : normalizeQuickTopologyTaskNames([options.entryTask]).find(task => usableTaskNames.includes(task)) ?? ''
  const entryTask = explicitEntryTask ?? (autoProbe ? pickQuickTopologyTaskName(usableTaskNames, autoProbe) : '')
  const probeKey = findTopologyProbeKey(entryTask) ?? requestedProbe?.key
  const probe = probeKey ? getTopologyProbe(probeKey) : requestedProbe
  const hopTask = landing
    ? (options.hopTask === undefined
        ? pickQuickHopTaskName(usableTaskNames, landing.name, entryTask)
        : normalizeQuickTopologyTaskNames([options.hopTask]).find(task => task !== entryTask) ?? '')
    : ''
  const entryLabel = probe?.label ?? '自定义入口'

  return createTopologyRoute(
    [
      { name: makeUniqueQuickEntryLabel(entryLabel, configuredNames), region: probe ? 'CN' : '', role: '入口' },
      { name: source.name.trim(), region: source.region?.trim() ?? '', role: '线路机', uuid: source.uuid },
      { name: landing?.name.trim() ?? '', region: landing?.region?.trim() ?? '', role: '落地机', uuid: landing?.uuid },
    ],
    [
      { live: Boolean(entryTask), nodeName: entryTask ? source.name.trim() : '', taskFilter: entryTask, fallbackLatency: null, fallbackLoss: null },
      {
        live: Boolean(hopTask),
        nodeName: hopTask ? source.name.trim() : '',
        taskFilter: hopTask,
        fallbackLatency: null,
        fallbackLoss: null,
      },
    ],
  )
}

export function validateTopologyRoutes(routes: TopologyRouteConfig[]): string[] {
  if (!routes.length)
    return []

  const seenEndpoints = new Map<string, number>()
  return routes.flatMap((route, routeIndex) => {
    const errors: string[] = []
    const routeLabel = `第 ${routeIndex + 1} 条线路`
    const nodes = route.nodes.slice(0, 3)
    const names = nodes.map(node => node.name.trim()).filter(Boolean)
    const lastConfiguredIndex = nodes.reduce((last, node, index) => node.name.trim() ? index : last, -1)

    for (const error of route.parseErrors ?? [])
      errors.push(`${routeLabel}${error}`)
    if (names.length < 2)
      errors.push(`${routeLabel}至少需要两个节点`)
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
      errors.push(`${routeLabel}存在重复节点`)
    if (nodes.slice(0, lastConfiguredIndex + 1).some(node => !node.name.trim()))
      errors.push(`${routeLabel}节点顺序存在空位`)
    if (nodes.some(node => [node.name, node.region, node.role].some(value => TOPOLOGY_NODE_RESERVED_PATTERN.test(value))))
      errors.push(`${routeLabel}节点名称、地区或角色不能包含“|”或“;”`)
    if (nodes.some(node => node.name.length > TOPOLOGY_LIMITS.nodeNameLength))
      errors.push(`${routeLabel}节点名称不能超过 ${TOPOLOGY_LIMITS.nodeNameLength} 个字符`)
    if (nodes.some(node => node.region.length > TOPOLOGY_LIMITS.regionLength))
      errors.push(`${routeLabel}地区不能超过 ${TOPOLOGY_LIMITS.regionLength} 个字符`)
    if (nodes.some(node => node.role.length > TOPOLOGY_LIMITS.roleLength))
      errors.push(`${routeLabel}角色不能超过 ${TOPOLOGY_LIMITS.roleLength} 个字符`)

    const endpoints = getTopologyRouteEndpoints(route)
    if (route.enabled && endpoints.source) {
      const endpointKey = `${endpoints.source}\u0000${endpoints.landing}`
      const duplicateOf = seenEndpoints.get(endpointKey)
      if (duplicateOf !== undefined)
        errors.push(`${routeLabel}与第 ${duplicateOf + 1} 条线路使用了相同的线路机和落地机`)
      else
        seenEndpoints.set(endpointKey, routeIndex)
    }

    const segmentCount = Math.max(1, lastConfiguredIndex)
    route.metrics.slice(0, segmentCount).forEach((metric, metricIndex) => {
      const segmentLabel = `${routeLabel}第 ${metricIndex + 1} 段`
      if (metric.live && (!metric.nodeName.trim() || !metric.taskFilter.trim()))
        errors.push(`${segmentLabel}缺少实时任务来源`)
      for (const error of metric.parseErrors ?? [])
        errors.push(`${segmentLabel}${error}`)
      if (metric.live && [metric.nodeName, metric.taskFilter].some(value => TOPOLOGY_METRIC_RESERVED_PATTERN.test(value)))
        errors.push(`${segmentLabel}来源节点或 Ping 任务不能包含“@”、“;”或“||”`)
      if (metric.nodeName.length > TOPOLOGY_LIMITS.nodeNameLength)
        errors.push(`${segmentLabel}来源节点不能超过 ${TOPOLOGY_LIMITS.nodeNameLength} 个字符`)
      if (metric.taskFilter.length > TOPOLOGY_LIMITS.taskNameLength)
        errors.push(`${segmentLabel}Ping 任务不能超过 ${TOPOLOGY_LIMITS.taskNameLength} 个字符`)
      if (metric.fallbackLatency !== null && metric.fallbackLatency < 0)
        errors.push(`${segmentLabel}备用延迟不能小于 0`)
      if (metric.fallbackLoss !== null && (metric.fallbackLoss < 0 || metric.fallbackLoss > 100))
        errors.push(`${segmentLabel}备用丢包必须在 0 到 100 之间`)
    })
    return errors
  })
}

export function formatTopologyLatency(value: number | null): string {
  if (value === null)
    return '-'
  return value >= 0 && value < 1 ? '<1ms' : `${Math.round(value)}ms`
}

export function formatTopologyLoss(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`
}

export type TopologySampleTone = 'healthy' | 'warning' | 'critical'

export function calculateTopologyLatencyBaseline(values: Array<number | null>): number | null {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right)
  if (!sorted.length)
    return null

  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2)
    return sorted[middle] ?? null
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

export function resolveTopologySampleTone(
  latency: number | null,
  loss: number | null,
  baseline: number | null,
): TopologySampleTone {
  if (latency === null || (loss ?? 0) >= 20)
    return 'critical'
  if ((loss ?? 0) > 3)
    return 'warning'

  const hasMeaningfulLatencySpike = baseline !== null
    && latency - baseline >= 5
    && (baseline <= 0 || latency > baseline * 1.18)
  return hasMeaningfulLatencySpike ? 'warning' : 'healthy'
}
