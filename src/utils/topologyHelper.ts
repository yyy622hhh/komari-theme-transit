import { formatCityNameZh } from '@/utils/cityNameHelper'

export interface TopologyNodeConfig {
  name: string
  region: string
  role: string
}

export interface TopologyMetricConfig {
  live: boolean
  nodeName: string
  taskFilter: string
  fallbackLatency: number | null
  fallbackLoss: number | null
  parseErrors?: string[]
}

export interface TopologyRouteConfig {
  id: number
  enabled: boolean
  nodes: TopologyNodeConfig[]
  metrics: TopologyMetricConfig[]
  parseErrors?: string[]
}

export interface TopologyProbeOption {
  key: string
  city: string
  carrier: string
  label: string
  taskFilter: string
}

export interface TopologyQuickNode {
  uuid?: string
  name: string
  region?: string
  online?: boolean
}

const TOPOLOGY_PROBE_SEPARATOR_PATTERN = /[\s\-_—–·]+/g
const TOPOLOGY_NODE_RESERVED_PATTERN = /[|;]/
const TOPOLOGY_METRIC_RESERVED_PATTERN = /@|;|\|\|/
const CJK_UNIFIED_IDEOGRAPH_REGEX = /\p{Script=Han}/u

export const TOPOLOGY_LIMITS = Object.freeze({
  maxRoutes: 50,
  rawValueLength: 65_536,
  nodeNameLength: 120,
  regionLength: 32,
  roleLength: 64,
  taskNameLength: 200,
})

export const TOPOLOGY_PROBE_OPTIONS: TopologyProbeOption[] = [
  { key: 'beijing-telecom', city: '北京', carrier: '电信', label: '北京电信', taskFilter: '北京电信' },
  { key: 'beijing-unicom', city: '北京', carrier: '联通', label: '北京联通', taskFilter: '北京联通' },
  { key: 'beijing-mobile', city: '北京', carrier: '移动', label: '北京移动', taskFilter: '北京移动' },
  { key: 'shanghai-telecom', city: '上海', carrier: '电信', label: '上海电信', taskFilter: '上海电信' },
  { key: 'shanghai-unicom', city: '上海', carrier: '联通', label: '上海联通', taskFilter: '上海联通' },
  { key: 'shanghai-mobile', city: '上海', carrier: '移动', label: '上海移动', taskFilter: '上海移动' },
  { key: 'guangzhou-telecom', city: '广州', carrier: '电信', label: '广州电信', taskFilter: '广东电信' },
  { key: 'guangzhou-unicom', city: '广州', carrier: '联通', label: '广州联通', taskFilter: '广东联通' },
  { key: 'guangzhou-mobile', city: '广州', carrier: '移动', label: '广州移动', taskFilter: '广东移动' },
]

export function normalizePingTaskName(value: string): string {
  return value.toLowerCase().replace(TOPOLOGY_PROBE_SEPARATOR_PATTERN, '')
}

export function getTopologyProbe(key?: string): TopologyProbeOption {
  return TOPOLOGY_PROBE_OPTIONS.find(option => option.key === key) ?? TOPOLOGY_PROBE_OPTIONS[0]!
}

export function findTopologyProbeKey(...values: string[]): string | undefined {
  const normalizedValues = values.map(normalizePingTaskName).filter(Boolean)
  return TOPOLOGY_PROBE_OPTIONS.find(option => normalizedValues.some((value) => {
    const taskName = normalizePingTaskName(option.taskFilter)
    const label = normalizePingTaskName(option.label)
    return value === taskName || value === label
  }))?.key
}

export function formatTopologyMetricNumber(value: number | null): string {
  return value === null ? '-' : `${value}`
}

/**
 * Describe where a displayed topology metric actually comes from.
 *
 * A live Komari Ping sample is collected by the configured source node. The
 * visual route labels are an operator-defined diagram and must not be used to
 * imply the opposite probe direction.
 */
export function formatTopologyTelemetryLabel(metric: string, visualSource: string, visualTarget: string): string {
  const configured = parseTopologyMetric(metric)
  if (!configured.live)
    return `${visualSource} → ${visualTarget}（静态基线）`

  const source = configured.nodeName || '未指定来源节点'
  const task = configured.taskFilter || '未指定任务'
  return `探测来源：${source} · Ping 任务：${task}`
}

export function formatTopologyMetricForProbe(metric: string, probeKey: string, targetFallback = ''): string {
  const configured = parseTopologyMetric(metric)
  if (!configured.live)
    return metric.trim() || '-,-'

  const defaultProbeKey = findTopologyProbeKey(configured.taskFilter)
  const probe = getTopologyProbe(probeKey || defaultProbeKey)
  const useConfiguredFallback = probe.key === defaultProbeKey
  return [
    'live',
    configured.nodeName || targetFallback,
    probe.taskFilter,
    formatTopologyMetricNumber(useConfiguredFallback ? configured.fallbackLatency : null),
    formatTopologyMetricNumber(useConfiguredFallback ? configured.fallbackLoss : null),
  ].join('@')
}

export function splitTopologyGroups(value: string, preserveEmpty = false): string[] {
  const groups = value
    .slice(0, TOPOLOGY_LIMITS.rawValueLength)
    .split('||')
    .slice(0, TOPOLOGY_LIMITS.maxRoutes)
    .map(group => group.trim())
  return preserveEmpty ? groups : groups.filter(Boolean)
}

function countTopologyGroups(value: string): number {
  let count = 1
  let offset = 0
  while (count <= TOPOLOGY_LIMITS.maxRoutes) {
    const separator = value.indexOf('||', offset)
    if (separator < 0)
      break
    count += 1
    offset = separator + 2
  }
  return count
}

export function getTopologyProbeStorageKey(routeGroup: string, metric: string): string {
  const configured = parseTopologyMetric(metric)
  return [routeGroup.trim(), configured.nodeName, configured.taskFilter].join('::')
}

export function createTopologyRoute(nodes: TopologyNodeConfig[] = [], metrics: TopologyMetricConfig[] = []): TopologyRouteConfig {
  return {
    id: Date.now() + Math.floor(Math.random() * 1_000_000),
    enabled: true,
    nodes,
    metrics,
  }
}

function quickNodeRank(node: TopologyQuickNode): number {
  if (node.online === true)
    return 0
  if (node.online === false)
    return 2
  return 1
}

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
      && nameCounts.get(node.name.trim().toLowerCase()) === 1
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

function findQuickTopologyTaskProbe(taskNames: readonly string[]): TopologyProbeOption | null {
  for (const taskName of taskNames) {
    const probeKey = findTopologyProbeKey(taskName.trim())
    if (probeKey)
      return getTopologyProbe(probeKey)
  }
  return null
}

function normalizeQuickTopologyTaskNames(taskNames: readonly string[]): string[] {
  return taskNames
    .map(task => task.trim())
    .filter(task => task && !TOPOLOGY_METRIC_RESERVED_PATTERN.test(task))
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

export function pickQuickTopologyTaskName(taskNames: readonly string[], probe: TopologyProbeOption = getTopologyProbe('')): string {
  const normalizedProbe = normalizePingTaskName(probe.taskFilter)
  const normalizedTasks = normalizeQuickTopologyTaskNames(taskNames)
  const matches = normalizedTasks.filter(task => normalizePingTaskName(task) === normalizedProbe)

  return matches.length === 1 ? matches[0]! : ''
}

export function listQuickTopologyProbeTasks(taskNames: readonly string[]): string[] {
  return normalizeQuickTopologyTaskNames(taskNames).filter(task => Boolean(findTopologyProbeKey(task)))
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

export function getTopologyRouteProbeKey(route: Pick<TopologyRouteConfig, 'nodes' | 'metrics'>): string {
  return findTopologyProbeKey(route.nodes[0]?.name ?? '', route.metrics[0]?.taskFilter ?? '') ?? ''
}

export function shouldAutoApplyTopologyProbe(route: Pick<TopologyRouteConfig, 'nodes' | 'metrics'>): boolean {
  const firstTask = route.metrics[0]?.taskFilter.trim() ?? ''
  if (!firstTask)
    return Boolean(findTopologyProbeKey(route.nodes[0]?.name ?? ''))
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
  route.metrics[0] = {
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

export function getTopologyRouteEndpoints(route: Pick<TopologyRouteConfig, 'nodes'>): { source: string, landing: string } {
  return {
    source: route.nodes[1]?.name.trim().toLowerCase() ?? '',
    landing: route.nodes[2]?.name.trim().toLowerCase() ?? '',
  }
}

export function findDuplicateTopologyRouteIndex(
  routes: readonly Pick<TopologyRouteConfig, 'nodes'>[],
  sourceName: string,
  landingName = '',
): number {
  const source = sourceName.trim().toLowerCase()
  const landing = landingName.trim().toLowerCase()
  if (!source)
    return -1
  return routes.findIndex((route) => {
    const ends = getTopologyRouteEndpoints(route)
    return ends.source === source && ends.landing === landing
  })
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
    return findDuplicateTopologyRouteIndex(routes, sourceName, node.name) < 0 ? [uuid] : []
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
      { name: source.name.trim(), region: source.region?.trim() ?? '', role: '线路机' },
      { name: landing?.name.trim() ?? '', region: landing?.region?.trim() ?? '', role: '落地机' },
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

export function parseTopologyRoutes(routeValue: string, metricValue: string): TopologyRouteConfig[] {
  // Routes and metrics are positional. Preserve empty groups in both arrays,
  // then discard only truly empty routes after their matching metric is read.
  const routeGroups = splitTopologyGroups(routeValue, true)
  const metricGroups = splitTopologyGroups(metricValue, true)
  const globalErrors: string[] = []
  if (routeValue.length > TOPOLOGY_LIMITS.rawValueLength || metricValue.length > TOPOLOGY_LIMITS.rawValueLength)
    globalErrors.push(`拓扑配置长度不能超过 ${TOPOLOGY_LIMITS.rawValueLength} 个字符`)
  if (countTopologyGroups(routeValue) > TOPOLOGY_LIMITS.maxRoutes || countTopologyGroups(metricValue) > TOPOLOGY_LIMITS.maxRoutes)
    globalErrors.push(`拓扑线路不能超过 ${TOPOLOGY_LIMITS.maxRoutes} 条`)

  const parsedRoutes = routeGroups.map((group, index) => {
    const routeSegments = group.split(';')
    const metricSegments = (metricGroups[index] || '').split(';')
    const nodes = parseTopologyNodes(group, true).slice(0, 3)
    const metrics = metricSegments
      .map(parseTopologyMetric)
      .slice(0, 2)
    while (nodes.length < 3)
      nodes.push({ name: '', region: '', role: nodes.length === 0 ? '入口' : nodes.length === 1 ? '线路机' : '落地机' })
    while (metrics.length < 2)
      metrics.push(parseTopologyMetric('-, -'))
    const route = createTopologyRoute(nodes, metrics)
    const parseErrors: string[] = []
    if (routeSegments.slice(3).some(segment => segment.trim()))
      parseErrors.push('最多支持三个节点，高级配置包含未显示的额外节点')
    if (metricSegments.slice(2).some(segment => segment.trim()))
      parseErrors.push('最多支持两段指标，高级配置包含未显示的额外指标')
    metrics.forEach((metric, metricIndex) => {
      for (const error of metric.parseErrors ?? [])
        parseErrors.push(`第 ${metricIndex + 1} 段${error}`)
    })
    if (parseErrors.length)
      route.parseErrors = parseErrors
    return route
  }).filter((route, index) => route.nodes.some(node => node.name.trim())
    || Boolean(metricGroups[index]?.trim())
    || Boolean(route.parseErrors?.length))

  if (globalErrors.length) {
    const firstRoute = parsedRoutes[0] ?? createTopologyRoute(
      [
        { name: '', region: '', role: '入口' },
        { name: '', region: '', role: '线路机' },
        { name: '', region: '', role: '落地机' },
      ],
      [parseTopologyMetric('-,-'), parseTopologyMetric('-,-')],
    )
    firstRoute.parseErrors = [...globalErrors, ...(firstRoute.parseErrors ?? [])]
    if (!parsedRoutes.length)
      parsedRoutes.push(firstRoute)
  }
  return parsedRoutes
}

export function formatTopologyMetric(config: TopologyMetricConfig): string {
  if (!config.live)
    return `${formatTopologyMetricNumber(config.fallbackLatency)},${formatTopologyMetricNumber(config.fallbackLoss)}`

  return [
    'live',
    config.nodeName.trim(),
    config.taskFilter.trim(),
    formatTopologyMetricNumber(config.fallbackLatency),
    formatTopologyMetricNumber(config.fallbackLoss),
  ].join('@')
}

export function serializeTopologyRoutes(routes: TopologyRouteConfig[]): { topologyRoute: string, topologyMetrics: string } {
  const activeRoutes = routes
    .filter(route => route.enabled)
    .map((route) => {
      const nodes = route.nodes.slice(0, 3)
      while (nodes.length && !nodes.at(-1)?.name.trim())
        nodes.pop()
      return { route, nodes }
    })
    .filter(({ nodes }) => nodes.filter(node => node.name.trim()).length >= 2)
  return {
    topologyRoute: activeRoutes.map(({ nodes }) => nodes
      .map(node => `${formatTopologyNodeField(node.name)}|${formatTopologyNodeField(node.region)}|${formatTopologyNodeField(node.role || '节点')}`)
      .join(';'))
      .join('||'),
    topologyMetrics: activeRoutes.map(({ route, nodes }) => route.metrics
      .slice(0, Math.max(1, nodes.length - 1))
      .map(formatTopologyMetric)
      .join(';'))
      .join('||'),
  }
}

function formatTopologyNodeField(value: string): string {
  const trimmed = value.trim()
  return trimmed || '-'
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

export function parseTopologyNodes(value: string, preserveEmpty = false): TopologyNodeConfig[] {
  const nodes = value.split(';').map((segment, index) => {
    const [name = '', region = '', ...roleParts] = segment.split('|').map(part => part.trim())
    const defaultRole = index === 0 ? '入口' : index === 1 ? '线路机' : index === 2 ? '落地机' : '节点'
    return {
      name: parseTopologyNodeField(name),
      region: parseTopologyNodeField(region),
      role: parseTopologyNodeField(roleParts.join('|')) || defaultRole,
    }
  })

  return preserveEmpty ? nodes : nodes.filter(node => node.name)
}

function parseTopologyNodeField(value: string): string {
  const trimmed = value.trim()
  return trimmed === '-' ? '' : trimmed
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value === '-' || value.trim() === '')
    return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isLegacyTopologyMetricBoundary(value: string | undefined): boolean {
  if (value === undefined)
    return false
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '-' || Number.isFinite(Number(trimmed))
}

function isKnownLegacyProbeParts(city: string | undefined, carrier: string | undefined): boolean {
  const normalizedCity = normalizePingTaskName(city?.trim() ?? '')
  const normalizedCarrier = normalizePingTaskName(carrier?.trim() ?? '')
  if (!normalizedCity || !normalizedCarrier)
    return false

  return TOPOLOGY_PROBE_OPTIONS.some((option) => {
    const carriers = [option.carrier]
    const prefixes = [option.city, option.label.slice(0, -option.carrier.length), option.taskFilter.slice(0, -option.carrier.length)]
    return carriers.some(value => normalizePingTaskName(value) === normalizedCarrier)
      && prefixes.some(value => normalizePingTaskName(value) === normalizedCity)
  })
}

export function parseTopologyMetric(value: string): TopologyMetricConfig {
  const normalized = value.trim()
  if (!normalized.startsWith('live@')) {
    const parts = normalized.split(',')
    const [latency, loss] = parts
    const parseErrors = parts.length > 2 ? ['静态指标包含非法“,”分隔符'] : []
    return {
      live: false,
      nodeName: '',
      taskFilter: '',
      fallbackLatency: parseNumber(latency),
      fallbackLoss: parseNumber(loss),
      ...(parseErrors.length ? { parseErrors } : {}),
    }
  }

  const parts = normalized.split('@')
  const parseErrors: string[] = []
  // 兼容旧格式 live@节点@地区@运营商@备用延迟@备用丢包。
  const legacyTaskFilter = `${parts[2]?.trim() ?? ''}${parts[3]?.trim() ?? ''}`
  const legacyFormat = parts.length === 6
    && isLegacyTopologyMetricBoundary(parts[4])
    && isLegacyTopologyMetricBoundary(parts[5])
    && isKnownLegacyProbeParts(parts[2], parts[3])
  if (parts.length !== 5 && !legacyFormat)
    parseErrors.push('实时指标包含非法“@”分隔符')
  const nodeName = parts[1]?.trim() ?? ''
  const taskFilter = legacyFormat
    ? legacyTaskFilter
    : parts[2]?.trim() ?? ''
  const fallbackLatency = parseNumber(legacyFormat ? parts[4] : parts[3])
  const fallbackLoss = parseNumber(legacyFormat ? parts[5] : parts[4])

  return { live: true, nodeName, taskFilter, fallbackLatency, fallbackLoss, ...(parseErrors.length ? { parseErrors } : {}) }
}

export function formatTopologyLatency(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}ms`
}

export function formatTopologyLoss(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`
}
