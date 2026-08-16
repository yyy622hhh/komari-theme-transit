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

export function getTopologyProbe(key: string): TopologyProbeOption {
  return TOPOLOGY_PROBE_OPTIONS.find(option => option.key === key) ?? TOPOLOGY_PROBE_OPTIONS[0]!
}

export function findTopologyProbeKey(...values: string[]): string {
  const normalizedValues = values.map(normalizePingTaskName).filter(Boolean)
  return TOPOLOGY_PROBE_OPTIONS.find(option => normalizedValues.some((value) => {
    const taskName = normalizePingTaskName(option.taskFilter)
    const label = normalizePingTaskName(option.label)
    return value.includes(taskName) || value.includes(label) || taskName.includes(value) || label.includes(value)
  }))?.key ?? TOPOLOGY_PROBE_OPTIONS[0]!.key
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

export function splitTopologyGroups(value: string): string[] {
  return value
    .split('||')
    .map(group => group.trim())
    .filter(Boolean)
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
  const routeGroups = splitTopologyGroups(routeValue)
  const metricGroups = splitTopologyGroups(metricValue)
  return routeGroups.map((group, index) => {
    const nodes = parseTopologyNodes(group).slice(0, 3)
    const metrics = (metricGroups[index] || '')
      .split(';')
      .filter(Boolean)
      .map(parseTopologyMetric)
      .slice(0, 2)
    while (metrics.length < Math.max(1, nodes.length - 1))
      metrics.push(parseTopologyMetric('-, -'))
    return createTopologyRoute(nodes, metrics)
  })
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
  const activeRoutes = routes.filter(route => route.enabled && route.nodes.length >= 2)
  return {
    topologyRoute: activeRoutes.map(route => route.nodes
      .slice(0, 3)
      .map(node => `${node.name.trim()}|${node.region.trim()}|${node.role.trim() || '节点'}`)
      .join(';'))
      .join('||'),
    topologyMetrics: activeRoutes.map(route => route.metrics
      .slice(0, Math.max(1, route.nodes.length - 1))
      .map(formatTopologyMetric)
      .join(';'))
      .join('||'),
  }
}

export function parseTopologyNodes(value: string): TopologyNodeConfig[] {
  return value
    .split(';')
    .map((segment) => {
      const [name = '', region = '', role = '节点'] = segment.split('|').map(part => part.trim())
      return { name, region, role }
    })
    .filter(node => node.name)
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
