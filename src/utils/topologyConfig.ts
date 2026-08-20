import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { createTopologyRoute, parseTopologyRoutes, TOPOLOGY_LIMITS } from '@/utils/topologyHelper'

/**
 * 拓扑配置的 JSON 存储格式。
 *
 * 取代 `topologyRoute` / `topologyMetrics` 两条位置分隔符字符串。旧格式把节点写成
 * `名称|地区|角色|UUID`、指标写成 `live@来源@任务@延迟@丢包`，两条字符串还必须按
 * 下标严格对齐；没有转义机制，含 `| ; @` 的名字只能靠校验拒绝，每加一个字段都要
 * 追加一个位置并为消歧义写一条特判。
 *
 * 迁移策略是「读兼容、写双份」：读取时优先用 JSON，没有就解析旧字段；保存时两份
 * 都写。跨一个版本确认没人回滚之后，才停写旧字段——那时候才能放开名字里的保留字符。
 */
export const TOPOLOGY_CONFIG_VERSION = 1

interface SerializedNode {
  name: string
  region?: string
  role?: string
  uuid?: string
}

interface SerializedMetric {
  live?: boolean
  source?: string
  task?: string
  fallbackLatency?: number | null
  fallbackLoss?: number | null
}

interface SerializedRoute {
  nodes: SerializedNode[]
  metrics: SerializedMetric[]
}

interface SerializedTopologyConfig {
  version: number
  routes: SerializedRoute[]
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function serializeNode(node: TopologyNodeConfig): SerializedNode {
  const uuid = node.uuid?.trim()
  const region = node.region.trim()
  const role = node.role.trim()
  return {
    name: node.name.trim(),
    ...(region ? { region } : {}),
    ...(role ? { role } : {}),
    ...(uuid ? { uuid } : {}),
  }
}

function serializeMetric(metric: TopologyMetricConfig): SerializedMetric {
  if (!metric.live) {
    return {
      ...(metric.fallbackLatency === null ? {} : { fallbackLatency: metric.fallbackLatency }),
      ...(metric.fallbackLoss === null ? {} : { fallbackLoss: metric.fallbackLoss }),
    }
  }
  return {
    live: true,
    source: metric.nodeName.trim(),
    task: metric.taskFilter.trim(),
    ...(metric.fallbackLatency === null ? {} : { fallbackLatency: metric.fallbackLatency }),
    ...(metric.fallbackLoss === null ? {} : { fallbackLoss: metric.fallbackLoss }),
  }
}

/** 和旧格式一致：只写启用的线路，并丢掉尾部空节点和少于两个节点的线路。 */
function activeRoutes(routes: readonly TopologyRouteConfig[]): Array<{ route: TopologyRouteConfig, nodes: TopologyNodeConfig[] }> {
  return routes
    .filter(route => route.enabled)
    .map((route) => {
      const nodes = route.nodes.slice(0, 3)
      while (nodes.length && !nodes.at(-1)?.name.trim())
        nodes.pop()
      return { route, nodes }
    })
    .filter(({ nodes }) => nodes.filter(node => node.name.trim()).length >= 2)
}

export function serializeTopologyConfig(routes: readonly TopologyRouteConfig[]): string {
  const payload: SerializedTopologyConfig = {
    version: TOPOLOGY_CONFIG_VERSION,
    routes: activeRoutes(routes).map(({ route, nodes }) => ({
      nodes: nodes.map(serializeNode),
      metrics: route.metrics.slice(0, Math.max(1, nodes.length - 1)).map(serializeMetric),
    })),
  }
  return JSON.stringify(payload)
}

function parseNode(value: unknown, index: number): TopologyNodeConfig {
  const record = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const defaultRole = index === 0 ? '入口' : index === 1 ? '线路机' : '落地机'
  const uuid = trimmed(record.uuid)
  return {
    name: trimmed(record.name),
    region: trimmed(record.region),
    role: trimmed(record.role) || defaultRole,
    ...(uuid ? { uuid } : {}),
  }
}

function parseMetric(value: unknown): TopologyMetricConfig {
  const record = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const live = record.live === true
  return {
    live,
    nodeName: live ? trimmed(record.source) : '',
    taskFilter: live ? trimmed(record.task) : '',
    fallbackLatency: finiteOrNull(record.fallbackLatency),
    fallbackLoss: finiteOrNull(record.fallbackLoss),
  }
}

function emptyMetric(): TopologyMetricConfig {
  return { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null }
}

/**
 * 解析 JSON 配置。
 *
 * 返回 `null` 表示「这里没有可用的 JSON」——调用方据此回退到旧字段。空数组是有效
 * 结果（操作者删光了所有线路），不能和「没配置过」混为一谈，否则删空之后一刷新
 * 旧线路又会从遗留字段里冒出来。
 */
export function parseTopologyConfig(raw: unknown): TopologyRouteConfig[] | null {
  if (typeof raw !== 'string' || !raw.trim())
    return null
  if (raw.length > TOPOLOGY_LIMITS.rawValueLength)
    return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null

  const payload = parsed as Record<string, unknown>
  // 版本号只用于「将来出现不认识的新格式时不要瞎解析」；同版本内新增可选字段
  // 走字段级容错，不需要抬版本。
  if (typeof payload.version === 'number' && payload.version > TOPOLOGY_CONFIG_VERSION)
    return null
  if (!Array.isArray(payload.routes))
    return null

  return payload.routes.slice(0, TOPOLOGY_LIMITS.maxRoutes).map((entry) => {
    const record = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>
    const rawNodes = Array.isArray(record.nodes) ? record.nodes.slice(0, 3) : []
    const rawMetrics = Array.isArray(record.metrics) ? record.metrics.slice(0, 2) : []
    const nodes = rawNodes.map(parseNode)
    const metrics = rawMetrics.map(parseMetric)
    // 界面永远按三节点两段渲染，缺的补空位，多的在上面已经截断。
    while (nodes.length < 3)
      nodes.push(parseNode({}, nodes.length))
    while (metrics.length < 2)
      metrics.push(emptyMetric())
    return createTopologyRoute(nodes, metrics)
  })
}

/**
 * 拓扑读取的唯一入口：有 JSON 用 JSON，没有才解析旧的两条字符串。
 *
 * 两条路径都必须走这里，否则「同一份配置在首页和管理器里解析出不同结果」这种
 * 问题会重新出现——旧格式的下标对齐历史上就出过这类 bug。
 */
export function readTopologyRoutes(
  configValue: unknown,
  routeValue: string,
  metricValue: string,
): TopologyRouteConfig[] {
  return parseTopologyConfig(configValue) ?? parseTopologyRoutes(routeValue, metricValue)
}
