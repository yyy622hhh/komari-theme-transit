/**
 * 拓扑的数据模型：类型、上限、保留字符和线路工厂。
 *
 * 单独成文件是为了打断依赖环——预设表、旧格式编解码和业务逻辑三边都要用这些
 * 定义，谁持有它谁就会被另外两边反向依赖。
 */

export interface TopologyNodeConfig {
  name: string
  region: string
  role: string
  /** 线路机/落地机在 Komari 里的 UUID。入口只是标签，一般没有。 */
  uuid?: string
  /** 自定义入口的 ICMP/TCP 探测目标；预设入口不需要保存。 */
  probeTarget?: string
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

export interface TopologyQuickNode {
  uuid?: string
  name: string
  region?: string
  online?: boolean
  ipv4?: string
  ipv6?: string
}

let nextTopologyRouteId = 0

export const TOPOLOGY_NODE_RESERVED_PATTERN = /[|;]/

export const TOPOLOGY_METRIC_RESERVED_PATTERN = /@|;|\|\|/

export const TOPOLOGY_LIMITS = Object.freeze({
  maxRoutes: 50,
  /** 入口、线路机、可选跳板、落地机。 */
  maxNodesPerRoute: 4,
  rawValueLength: 65_536,
  nodeNameLength: 120,
  regionLength: 32,
  roleLength: 64,
  taskNameLength: 200,
  probeTargetLength: 253,
})

export function defaultTopologyNodeRole(index: number, total: number): string {
  if (index === 0)
    return '入口'
  if (index === 1)
    return '线路机'
  if (index === total - 1)
    return '落地机'
  return '跳板'
}

export function createTopologyRoute(nodes: TopologyNodeConfig[] = [], metrics: TopologyMetricConfig[] = []): TopologyRouteConfig {
  nextTopologyRouteId = Math.max(nextTopologyRouteId + 1, Date.now() * 1_000)
  return {
    id: nextTopologyRouteId,
    enabled: true,
    nodes,
    metrics,
  }
}
