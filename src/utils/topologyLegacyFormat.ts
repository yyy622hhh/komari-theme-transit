import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyModel'
import { createTopologyRoute, TOPOLOGY_LIMITS, TOPOLOGY_NODE_RESERVED_PATTERN } from '@/utils/topologyModel'
import { findTopologyProbeKey, getTopologyProbe, normalizePingTaskName, resolveTopologyProbeTaskName, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'

/**
 * 旧的分隔符字符串格式：`名称|地区|角色|UUID` 与 `live@来源@任务@延迟@丢包`。
 *
 * 真值已经是 `topologyConfig`（JSON，见 utils/topologyConfig.ts）。这里保留的是
 * 兼容层：读取时用来解析还没迁移的站点，保存时继续写一份，好让降级安装不会看到
 * 空拓扑。确认无人回滚之后，整个文件连同 TOPOLOGY_NODE_RESERVED_PATTERN 一起删除
 * ——那时名字里才能出现 `|` `;` `@`。
 */

function formatTopologyMetricNumber(value: number | null): string {
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

export function formatTopologyMetricForProbe(
  metric: string,
  probeKey: string,
  targetFallback = '',
  taskNames: readonly string[] = [],
): string {
  const configured = parseTopologyMetric(metric)
  if (!configured.live)
    return metric.trim() || '-,-'

  const defaultProbeKey = findTopologyProbeKey(configured.taskFilter)
  const probe = getTopologyProbe(probeKey || defaultProbeKey)
  const useConfiguredFallback = probe.key === defaultProbeKey
  return [
    'live',
    configured.nodeName || targetFallback,
    resolveTopologyProbeTaskName(probe.key, taskNames, configured.taskFilter),
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

export function getTopologyProbeStorageKey(routeGroup: string, metric: string, disambiguator = ''): string {
  const configured = parseTopologyMetric(metric)
  return [routeGroup.trim(), configured.nodeName, configured.taskFilter, disambiguator.trim()].filter(Boolean).join('::')
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
      // 旧格式只能表达三节点。含跳板时为降级页面保留入口、线路机和最终落地机，
      // 完整四节点结构只存在 topologyConfig JSON 中。
      const nodes = route.nodes.length >= 4
        ? [route.nodes[0]!, route.nodes[1]!, route.nodes.at(-1)!]
        : route.nodes.slice(0, 3)
      while (nodes.length && !nodes.at(-1)?.name.trim())
        nodes.pop()
      return { route, nodes }
    })
    .filter(({ nodes }) => nodes.filter(node => node.name.trim()).length >= 2)
  return {
    topologyRoute: activeRoutes.map(({ nodes }) => nodes
      .map((node) => {
        const base = `${formatTopologyNodeField(node.name)}|${formatTopologyNodeField(node.region)}|${formatTopologyNodeField(node.role || '节点')}`
        const uuid = node.uuid?.trim()
        return uuid && !TOPOLOGY_NODE_RESERVED_PATTERN.test(uuid) ? `${base}|${uuid}` : base
      })
      .join(';'))
      .join('||'),
    topologyMetrics: activeRoutes.map(({ route, nodes }) => (route.nodes.length >= 4
      ? [route.metrics[0]!, route.metrics.at(-1)!]
      : route.metrics.slice(0, Math.max(1, nodes.length - 1)))
      .map(formatTopologyMetric)
      .join(';'))
      .join('||'),
  }
}

function formatTopologyNodeField(value: string): string {
  const trimmed = value.trim()
  return trimmed || '-'
}

function parseTopologyNodes(value: string, preserveEmpty = false): TopologyNodeConfig[] {
  const nodes = value.split(';').map((segment, index) => {
    const parts = segment.split('|').map(part => part.trim())
    const [name = '', region = '', roleRaw = '', maybeUuid = ''] = parts
    const defaultRole = index === 0 ? '入口' : index === 1 ? '线路机' : index === 2 ? '落地机' : '节点'
    if (parts.length > 4) {
      return {
        name: parseTopologyNodeField(name),
        region: parseTopologyNodeField(region),
        role: parseTopologyNodeField(parts.slice(2).join('|')) || defaultRole,
      }
    }
    const uuid = parseTopologyNodeField(maybeUuid)
    return {
      name: parseTopologyNodeField(name),
      region: parseTopologyNodeField(region),
      role: parseTopologyNodeField(roleRaw) || defaultRole,
      ...(uuid ? { uuid } : {}),
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
      probeMode: 'static',
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

  return { probeMode: 'live', live: true, nodeName, taskFilter, fallbackLatency, fallbackLoss, ...(parseErrors.length ? { parseErrors } : {}) }
}
