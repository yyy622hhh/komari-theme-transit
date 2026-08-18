import type { NodeData } from '@/stores/nodes'
import { getDaysUntilExpired } from '@/utils/tagHelper'

export interface TopNodeMetric {
  node: NodeData
  value: number
}

export interface HighLoadMetric {
  key: 'cpu' | 'memory' | 'disk'
  label: string
  percentage: number
}

export function hasTrafficLimit(node: Pick<NodeData, 'traffic_limit'>): boolean {
  return (node.traffic_limit || 0) > 0
}

export function getTrafficUsed(node: Pick<NodeData, 'net_total_up' | 'net_total_down' | 'traffic_limit_type'>): number {
  const { net_total_up = 0, net_total_down = 0, traffic_limit_type } = node

  switch (traffic_limit_type) {
    case 'up': return net_total_up
    case 'down': return net_total_down
    case 'min': return Math.min(net_total_up, net_total_down)
    case 'max': return Math.max(net_total_up, net_total_down)
    case 'sum':
    default: return net_total_up + net_total_down
  }
}

export function getTrafficUsedPercentage(node: Pick<NodeData, 'traffic_limit' | 'net_total_up' | 'net_total_down' | 'traffic_limit_type'>): number {
  if (!hasTrafficLimit(node))
    return 0

  return clampPercentage(getTrafficUsed(node) / node.traffic_limit * 100)
}

export function getRealtimeTotalSpeed(node: Pick<NodeData, 'net_in' | 'net_out'>): number {
  return (node.net_in || 0) + (node.net_out || 0)
}

export function getRealtimePeakSpeed(node: Pick<NodeData, 'net_in' | 'net_out'>): number {
  return Math.max(node.net_in || 0, node.net_out || 0)
}

export function getTotalTraffic(node: Pick<NodeData, 'net_total_up' | 'net_total_down'>): number {
  return (node.net_total_up || 0) + (node.net_total_down || 0)
}

export function getConnectionCount(node: Pick<NodeData, 'connections' | 'connections_udp'>): number {
  return (node.connections || 0) + (node.connections_udp || 0)
}

/**
 * 归一化 Komari 上报的连接数：`connections` 是 TCP + UDP 的合计，`connections_udp`
 * 是其中的 UDP 部分，相减才得到 TCP。
 *
 * `NodeStatus`（`/latest` 实时状态）和 `StatusRecord`（`common:getRecords` 历史
 * 记录）是同一份 agent 上报结构的两种投影，因此两条路径都必须过这里，否则实时
 * 卡片和历史图表会对同一台机器给出不同的 TCP 数值。
 *
 * 例外是 `public:queryMetrics`：它的 `connections.tcp` / `connections.udp` 已经
 * 是拆开的定义，不需要也不能再相减（见 utils/loadMetricRecords.ts）。
 */
export function normalizeConnectionCounts(connections: number, connectionsUdp: number): { tcp: number, udp: number } {
  const udp = Math.max(0, connectionsUdp || 0)
  return {
    tcp: Math.max(0, (connections || 0) - udp),
    udp,
  }
}

export function getMemoryPercentage(node: Pick<NodeData, 'ram' | 'mem_total'>): number {
  return clampPercentage((node.ram || 0) / (node.mem_total || 1) * 100)
}

export function getDiskPercentage(node: Pick<NodeData, 'disk' | 'disk_total'>): number {
  return clampPercentage((node.disk || 0) / (node.disk_total || 1) * 100)
}

export function getHighLoadMetrics(node: NodeData, threshold: number): HighLoadMetric[] {
  if (!node.online)
    return []

  const metrics: HighLoadMetric[] = []
  const safeThreshold = clampThreshold(threshold, 80)
  const cpu = clampPercentage(node.cpu || 0)
  const memory = getMemoryPercentage(node)
  const disk = getDiskPercentage(node)

  if (cpu >= safeThreshold)
    metrics.push({ key: 'cpu', label: 'CPU', percentage: cpu })
  if (memory >= safeThreshold)
    metrics.push({ key: 'memory', label: '内存', percentage: memory })
  if (disk >= safeThreshold)
    metrics.push({ key: 'disk', label: '硬盘', percentage: disk })

  return metrics
}

export function isHighLoadNode(node: NodeData, threshold: number): boolean {
  return getHighLoadMetrics(node, threshold).length > 0
}

export function hasValidExpiry(node: Pick<NodeData, 'expired_at'>): boolean {
  if (!node.expired_at)
    return false

  const time = Date.parse(String(node.expired_at))
  return Number.isFinite(time)
}

export function getExpiryDays(node: Pick<NodeData, 'expired_at'>): number | null {
  if (!hasValidExpiry(node))
    return null

  return getDaysUntilExpired(node.expired_at)
}

export function isExpiringNode(node: NodeData, days: number): boolean {
  if (node.price === 0)
    return false

  const expiryDays = getExpiryDays(node)
  if (expiryDays === null)
    return false

  return expiryDays <= Math.max(1, days)
}

export function isTrafficWarningNode(node: NodeData, threshold: number): boolean {
  if (!hasTrafficLimit(node))
    return false

  return getTrafficUsedPercentage(node) >= clampThreshold(threshold, 80)
}

export function getTopNodeBy(nodes: readonly NodeData[], selector: (node: NodeData) => number): TopNodeMetric | null {
  let topNode: NodeData | null = null
  let topValue = -Infinity

  for (const node of nodes) {
    const value = selector(node)
    if (!Number.isFinite(value))
      continue

    if (value > topValue) {
      topValue = value
      topNode = node
    }
  }

  if (!topNode)
    return null

  return { node: topNode, value: Math.max(0, topValue) }
}

export function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value))
    return fallback

  return Math.min(Math.max(value, 1), 100)
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value))
    return 0

  return Math.min(Math.max(value, 0), 100)
}

// ==================== 首页汇总卡片：聚合与格式化 ====================
// 从 NodeGeneralCards.vue 抽出的纯函数：只依赖显式参数，不碰 Vue 响应式或
// Pinia store，可以直接单测，也让组件本身少背一份可能算错的聚合逻辑。

export interface OnlineNodeStats {
  count: number
  totalSpeed: { up: number, down: number }
  avgCpu: number
  totalGpu: number
  gpuNodeCount: number
  avgLoad: number
  avgLoad5: number
  avgLoad15: number
  totalProcesses: number
  totalConnectionsTcp: number
  totalConnectionsUdp: number
  trafficPeak: TopNodeMetric | null
  uploadPeakNode: TopNodeMetric | null
  downloadPeakNode: TopNodeMetric | null
  gpuPeakNode: TopNodeMetric | null
  connectionPeakNode: TopNodeMetric | null
  highLoadNodes: NodeData[]
}

function updateTopNodeMetric(current: TopNodeMetric | null, node: NodeData, value: number): TopNodeMetric | null {
  if (!Number.isFinite(value))
    return current

  if (!current || value > current.value)
    return { node, value: Math.max(0, value) }

  return current
}

/** 首页总览卡片的核心聚合：只看在线节点的单次遍历求和/求峰值。 */
export function computeOnlineNodeStats(nodes: readonly NodeData[], highLoadThreshold: number): OnlineNodeStats {
  const stats: OnlineNodeStats = {
    count: 0,
    totalSpeed: { up: 0, down: 0 },
    avgCpu: 0,
    totalGpu: 0,
    gpuNodeCount: 0,
    avgLoad: 0,
    avgLoad5: 0,
    avgLoad15: 0,
    totalProcesses: 0,
    totalConnectionsTcp: 0,
    totalConnectionsUdp: 0,
    trafficPeak: null,
    uploadPeakNode: null,
    downloadPeakNode: null,
    gpuPeakNode: null,
    connectionPeakNode: null,
    highLoadNodes: [],
  }

  for (const node of nodes) {
    if (!node.online)
      continue

    stats.count += 1
    stats.totalSpeed.up += node.net_out || 0
    stats.totalSpeed.down += node.net_in || 0
    stats.avgCpu += node.cpu || 0
    stats.avgLoad += node.load || 0
    stats.avgLoad5 += node.load5 || 0
    stats.avgLoad15 += node.load15 || 0
    stats.totalProcesses += node.process || 0
    stats.totalConnectionsTcp += node.connections || 0
    stats.totalConnectionsUdp += node.connections_udp || 0
    stats.trafficPeak = updateTopNodeMetric(stats.trafficPeak, node, getRealtimeTotalSpeed(node))
    stats.uploadPeakNode = updateTopNodeMetric(stats.uploadPeakNode, node, node.net_out || 0)
    stats.downloadPeakNode = updateTopNodeMetric(stats.downloadPeakNode, node, node.net_in || 0)
    stats.connectionPeakNode = updateTopNodeMetric(stats.connectionPeakNode, node, getConnectionCount(node))
    const hasGpu = Boolean(node.gpu_name?.trim()) || (node.gpu || 0) > 0
    if (hasGpu) {
      stats.totalGpu += node.gpu || 0
      stats.gpuNodeCount += 1
      stats.gpuPeakNode = updateTopNodeMetric(stats.gpuPeakNode, node, node.gpu || 0)
    }
    if (isHighLoadNode(node, highLoadThreshold))
      stats.highLoadNodes.push(node)
  }

  if (stats.count > 0) {
    stats.avgCpu /= stats.count
    stats.avgLoad /= stats.count
    stats.avgLoad5 /= stats.count
    stats.avgLoad15 /= stats.count
  }

  return stats
}

export function formatNodeCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatMetricDecimal(value: number, digits = 1): string {
  if (!Number.isFinite(value))
    return '0'
  return value.toFixed(digits)
}

/** 列出节点名字，超过 max 个折叠成一行「… 还有 N 台」。 */
export function formatNodeNameList(nodes: readonly NodeData[], formatter?: (node: NodeData) => string, max = 8): string {
  if (nodes.length === 0)
    return '暂无节点'

  const lines = nodes.slice(0, max).map(node => formatter ? formatter(node) : node.name)
  if (nodes.length > max)
    lines.push(`… 还有 ${nodes.length - max} 台`)
  return lines.join('\n')
}

/** 按 selector 分组计数，未知/空值归入「未知」，按数量降序。 */
export function getNodeDistribution(nodes: readonly NodeData[], selector: (node: NodeData) => string | null | undefined): Array<[string, number]> {
  const map = new Map<string, number>()
  for (const node of nodes) {
    const key = selector(node)?.trim() || '未知'
    map.set(key, (map.get(key) || 0) + 1)
  }

  return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
}

/** 同 {@link getNodeDistribution}，但丢弃空值而不是归入「未知」。 */
export function getKnownNodeDistribution(nodes: readonly NodeData[], selector: (node: NodeData) => string | null | undefined): Array<[string, number]> {
  const map = new Map<string, number>()
  for (const node of nodes) {
    const key = selector(node)?.trim()
    if (!key)
      continue
    map.set(key, (map.get(key) || 0) + 1)
  }

  return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
}

export function formatDistributionTooltip(entries: ReadonlyArray<[string, number]>): string {
  if (entries.length === 0)
    return '暂无数据'

  return entries.slice(0, 8).map(([key, count]) => `${key}: ${count} 台`).join('\n')
}

export function formatExpiryNodeLine(node: NodeData): string {
  const days = getExpiryDays(node)
  if (days === null)
    return `${node.name}: 未知`
  if (days <= 0)
    return `${node.name}: 已过期`
  return `${node.name}: ${days} 天`
}
