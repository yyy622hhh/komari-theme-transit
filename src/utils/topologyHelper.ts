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
}

export interface TopologyRouteConfig {
  id: number
  enabled: boolean
  nodes: TopologyNodeConfig[]
  metrics: TopologyMetricConfig[]
}

export interface TopologyProbeOption {
  key: string
  city: string
  carrier: string
  label: string
  taskFilter: string
}

const TOPOLOGY_PROBE_SEPARATOR_PATTERN = /[\s\-_—–·]+/g

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
    .split('||')
    .map(group => group.trim())
  return preserveEmpty ? groups : groups.filter(Boolean)
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

export function parseTopologyRoutes(routeValue: string, metricValue: string): TopologyRouteConfig[] {
  // Routes and metrics are positional. Preserve empty groups in both arrays,
  // then discard only truly empty routes after their matching metric is read.
  const routeGroups = splitTopologyGroups(routeValue, true)
  const metricGroups = splitTopologyGroups(metricValue, true)
  return routeGroups.map((group, index) => {
    const nodes = parseTopologyNodes(group, true).slice(0, 3)
    const metrics = (metricGroups[index] || '')
      .split(';')
      .map(parseTopologyMetric)
      .slice(0, 2)
    while (nodes.length < 3)
      nodes.push({ name: '', region: '', role: nodes.length === 0 ? '入口' : nodes.length === 1 ? '线路机' : '落地机' })
    while (metrics.length < 2)
      metrics.push(parseTopologyMetric('-, -'))
    return createTopologyRoute(nodes, metrics)
  }).filter(route => route.nodes.some(node => node.name.trim()))
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
      .map(node => `${node.name.trim()}|${node.region.trim()}|${node.role.trim() || '节点'}`)
      .join(';'))
      .join('||'),
    topologyMetrics: activeRoutes.map(({ route, nodes }) => route.metrics
      .slice(0, Math.max(1, nodes.length - 1))
      .map(formatTopologyMetric)
      .join(';'))
      .join('||'),
  }
}

const TOPOLOGY_NODE_RESERVED_PATTERN = /[|;]/
const TOPOLOGY_METRIC_RESERVED_PATTERN = /@|;|\|\|/

export function validateTopologyRoutes(routes: TopologyRouteConfig[]): string[] {
  return routes.flatMap((route, routeIndex) => {
    const errors: string[] = []
    const routeLabel = `第 ${routeIndex + 1} 条线路`
    const nodes = route.nodes.slice(0, 3)
    const names = nodes.map(node => node.name.trim()).filter(Boolean)
    const lastConfiguredIndex = nodes.reduce((last, node, index) => node.name.trim() ? index : last, -1)

    if (names.length < 2)
      errors.push(`${routeLabel}至少需要两个节点`)
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
      errors.push(`${routeLabel}存在重复节点`)
    if (nodes.slice(0, lastConfiguredIndex + 1).some(node => !node.name.trim()))
      errors.push(`${routeLabel}节点顺序存在空位`)
    if (nodes.some(node => [node.name, node.region, node.role].some(value => TOPOLOGY_NODE_RESERVED_PATTERN.test(value))))
      errors.push(`${routeLabel}节点名称、地区或角色不能包含“|”或“;”`)

    const segmentCount = Math.max(1, lastConfiguredIndex)
    route.metrics.slice(0, segmentCount).forEach((metric, metricIndex) => {
      const segmentLabel = `${routeLabel}第 ${metricIndex + 1} 段`
      if (metric.live && (!metric.nodeName.trim() || !metric.taskFilter.trim()))
        errors.push(`${segmentLabel}缺少实时任务来源`)
      if (metric.live && [metric.nodeName, metric.taskFilter].some(value => TOPOLOGY_METRIC_RESERVED_PATTERN.test(value)))
        errors.push(`${segmentLabel}来源节点或 Ping 任务不能包含“@”、“;”或“||”`)
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
      name,
      region,
      role: roleParts.join('|').trim() || defaultRole,
    }
  })

  return preserveEmpty ? nodes : nodes.filter(node => node.name)
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value === '-' || value.trim() === '')
    return null
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : null
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
  // 兼容旧格式 live@节点@地区@运营商@备用延迟@备用丢包。
  const legacyFormat = parts.length >= 6
  const nodeName = parts[1]?.trim() ?? ''
  const taskFilter = legacyFormat
    ? `${parts[2]?.trim() ?? ''}${parts[3]?.trim() ?? ''}`
    : parts[2]?.trim() ?? ''
  const fallbackLatency = parseNumber(legacyFormat ? parts[4] : parts[3])
  const fallbackLoss = parseNumber(legacyFormat ? parts[5] : parts[4])

  return { live: true, nodeName, taskFilter, fallbackLatency, fallbackLoss }
}

export function formatTopologyLatency(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}ms`
}

export function formatTopologyLoss(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`
}
