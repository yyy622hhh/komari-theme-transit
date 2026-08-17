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

function getQuickTopologyNodes<T extends TopologyQuickNode>(nodes: readonly T[]): T[] {
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
  return getQuickTopologyNodes(nodes)[0] ?? null
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

  return normalizedTasks.find(task => normalizePingTaskName(task) === normalizedProbe)
    ?? normalizedTasks[0]
    ?? probe.taskFilter
}

export function buildQuickTopologyRoute(nodes: readonly TopologyQuickNode[], taskNames: readonly string[] = [], sourceUuid = ''): TopologyRouteConfig | null {
  const candidates = getQuickTopologyNodes(nodes)
  const source = sourceUuid
    ? candidates.find(node => node.uuid === sourceUuid)
    : candidates[0]
  if (!source)
    return null

  const configuredNames = new Set(candidates.map(node => node.name.trim().toLowerCase()))
  const usableTaskNames = normalizeQuickTopologyTaskNames(taskNames)
  const probe = findQuickTopologyTaskProbe(usableTaskNames)
  const taskFilter = probe ? pickQuickTopologyTaskName(usableTaskNames, probe) : usableTaskNames[0] ?? ''
  const entryLabel = probe?.label ?? '自定义入口'
  const sourceName = source.name.trim().toLowerCase()
  const landing = candidates.find(node => node !== source && node.name.trim().toLowerCase() !== sourceName)

  return createTopologyRoute(
    [
      { name: makeUniqueQuickEntryLabel(entryLabel, configuredNames), region: probe ? 'CN' : '', role: '入口' },
      { name: source.name.trim(), region: source.region?.trim() ?? '', role: '线路机' },
      { name: landing?.name.trim() ?? '', region: landing?.region?.trim() ?? '', role: '落地机' },
    ],
    [
      { live: Boolean(taskFilter), nodeName: taskFilter ? source.name.trim() : '', taskFilter, fallbackLatency: null, fallbackLoss: null },
      { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
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
  }).filter(route => route.nodes.some(node => node.name.trim()))

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

export function parseTopologyMetric(value: string): TopologyMetricConfig {
  const normalized = value.trim()
  if (!normalized.startsWith('live@')) {
    const [latency, loss] = normalized.split(',')
    return {
      live: false,
      nodeName: '',
      taskFilter: '',
      fallbackLatency: parseNumber(latency),
      fallbackLoss: parseNumber(loss),
    }
  }

  const parts = normalized.split('@')
  const parseErrors: string[] = []
  // 兼容旧格式 live@节点@地区@运营商@备用延迟@备用丢包。
  const legacyTaskFilter = `${parts[2]?.trim() ?? ''}${parts[3]?.trim() ?? ''}`
  const legacyFormat = parts.length === 6
    && isLegacyTopologyMetricBoundary(parts[4])
    && isLegacyTopologyMetricBoundary(parts[5])
    && Boolean(findTopologyProbeKey(legacyTaskFilter))
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
