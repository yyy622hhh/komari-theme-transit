<script setup lang="ts">
import type { GeneralCardKey } from '@/stores/app'
import type { NodeData } from '@/stores/nodes'
import type { CurrencyCode, ExchangeRateSource } from '@/utils/financeHelper'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref } from 'vue'
import NodeEarthGlobe from '@/components/NodeEarthGlobe.vue'
import { CardX } from '@/components/ui/card-x'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import * as financeHelper from '@/utils/financeHelper'
import { formatBytesPerSecondSplit, formatBytesSplit } from '@/utils/helper'
import {
  getConnectionCount,
  getExpiryDays,
  getHighLoadMetrics,
  getRealtimeTotalSpeed,
  getTopNodeBy,
  getTrafficUsed,
  getTrafficUsedPercentage,
  isExpiringNode,
  isHighLoadNode,
  isTrafficWarningNode,
} from '@/utils/nodeMetricsHelper'

interface GeneralMetricCard {
  key: GeneralCardKey
  label: string
  icon: string
  value: string
  unit?: string
  tooltip?: string
}

const props = defineProps<{
  nodes?: NodeData[]
  globeNodes?: NodeData[]
  transitionKey?: string
}>()
const appStore = useAppStore()
const nodesStore = useNodesStore()
// 未登录且开启「未登录隐藏价格」时，屏蔽金额类信息
const showPrice = computed(() => appStore.isLoggedIn || !appStore.hidePriceWhenLoggedOut)
const exchangeRates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
const exchangeRateSource = ref<ExchangeRateSource | 'loading'>('loading')
const financeCurrency = ref<CurrencyCode>('CNY')
const excludeFreeNodes = ref(true)
const summaryNodes = computed(() => props.nodes ?? nodesStore.nodes)
const onlineNodes = computed(() => summaryNodes.value.filter(node => node.online))
const summaryTransitionKey = computed(() => props.transitionKey ?? summaryNodes.value.map(node => node.uuid).join('|'))
const metricSwitchTransitionProps = computed(() => ({
  ...(appStore.disablePageAnimation
    ? { css: false }
    : { name: 'metric-switch', mode: 'out-in' as const }),
}))

function getMetricSwitchStyle(index: number): Record<string, string> {
  return {
    '--metric-switch-delay': `${index * 35}ms`,
  }
}

function formatBytesText(bytes: number): string {
  const formatted = formatBytesSplit(bytes, appStore.byteDecimals)
  return `${formatted.value} ${formatted.unit}`
}

function formatSpeedText(bytes: number): string {
  const formatted = formatBytesPerSecondSplit(bytes, appStore.byteDecimals)
  return `${formatted.value} ${formatted.unit}`
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

function formatDecimal(value: number, digits = 1): string {
  if (!Number.isFinite(value))
    return '0'
  return value.toFixed(digits)
}

function averageBy(nodes: NodeData[], selector: (node: NodeData) => number): number {
  if (nodes.length === 0)
    return 0
  return nodes.reduce((sum, node) => sum + (selector(node) || 0), 0) / nodes.length
}

function formatTopNodeSpeed(metric: ReturnType<typeof getTopNodeBy>, fallback = '-'): { value: string, unit?: string, tooltip?: string } {
  if (!metric || metric.value <= 0)
    return { value: fallback }

  const formatted = formatBytesPerSecondSplit(metric.value, appStore.byteDecimals)
  return {
    value: formatted.value,
    unit: formatted.unit,
    tooltip: `${metric.node.name}\n↑ ${formatSpeedText(metric.node.net_out || 0)}\n↓ ${formatSpeedText(metric.node.net_in || 0)}`,
  }
}

function formatNodeNames(nodes: NodeData[], formatter?: (node: NodeData) => string, max = 8): string {
  if (nodes.length === 0)
    return '暂无节点'

  const lines = nodes.slice(0, max).map(node => formatter ? formatter(node) : node.name)
  if (nodes.length > max)
    lines.push(`… 还有 ${nodes.length - max} 台`)
  return lines.join('\n')
}

function getDistribution(nodes: NodeData[], selector: (node: NodeData) => string | null | undefined): Array<[string, number]> {
  const map = new Map<string, number>()
  for (const node of nodes) {
    const key = selector(node)?.trim() || '未知'
    map.set(key, (map.get(key) || 0) + 1)
  }

  return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
}

function formatDistributionTooltip(entries: Array<[string, number]>): string {
  if (entries.length === 0)
    return '暂无数据'

  return entries.slice(0, 8).map(([key, count]) => `${key}: ${count} 台`).join('\n')
}

function formatExpiryNode(node: NodeData): string {
  const days = getExpiryDays(node)
  if (days === null)
    return `${node.name}: 未知`
  if (days <= 0)
    return `${node.name}: 已过期`
  return `${node.name}: ${days} 天`
}

function getNodePeriodCostCNY(node: NodeData, periodDays: number): number {
  if (excludeFreeNodes.value && node.tags?.includes('白嫖中'))
    return 0

  return financeHelper.calculatePeriodCostCNY(node, exchangeRates.value, periodDays)
}

function formatCostCard(amountCNY: number): { value: string, unit?: string } {
  if (!showPrice.value)
    return { value: '***' }

  const targetRate = exchangeRates.value[financeCurrency.value] || 1
  const formatted = financeHelper.formatFinanceAmount(amountCNY * targetRate, financeCurrency.value)
  return {
    value: `${formatted.symbol}${formatted.value}`,
    unit: formatted.currency,
  }
}

const totalSpeed = computed(() => {
  const up = onlineNodes.value.reduce((sum, node) => sum + (node.net_out || 0), 0)
  const down = onlineNodes.value.reduce((sum, node) => sum + (node.net_in || 0), 0)
  return { up, down }
})

const totalTraffic = computed(() => {
  const up = summaryNodes.value.reduce((sum, node) => sum + (node.net_total_up || 0), 0)
  const down = summaryNodes.value.reduce((sum, node) => sum + (node.net_total_down || 0), 0)
  return { up, down }
})

const formattedTrafficUp = computed(() => formatBytesSplit(totalTraffic.value.up, appStore.byteDecimals))
const formattedTrafficDown = computed(() => formatBytesSplit(totalTraffic.value.down, appStore.byteDecimals))
const totalTrafficTooltip = computed(() => formatBytesSplit(totalTraffic.value.up + totalTraffic.value.down, appStore.byteDecimals))

const formattedSpeedUp = computed(() => formatBytesPerSecondSplit(totalSpeed.value.up, appStore.byteDecimals))
const formattedSpeedDown = computed(() => formatBytesPerSecondSplit(totalSpeed.value.down, appStore.byteDecimals))

// ==================== 内存 / 硬盘 / 交换内存 汇总 ====================
// 离线节点的 ram / disk / swap 为 0，不影响 used 求和；total 是静态库存信息，按全量统计
const totalMemory = computed(() => {
  let used = 0
  let total = 0
  for (const node of summaryNodes.value) {
    used += node.ram || 0
    total += node.mem_total || 0
  }
  return { used, total }
})

const totalDisk = computed(() => {
  let used = 0
  let total = 0
  for (const node of summaryNodes.value) {
    used += node.disk || 0
    total += node.disk_total || 0
  }
  return { used, total }
})

const totalSwap = computed(() => {
  let used = 0
  let total = 0
  for (const node of summaryNodes.value) {
    used += node.swap || 0
    total += node.swap_total || 0
  }
  return { used, total }
})

const formattedMemoryUsed = computed(() => formatBytesSplit(totalMemory.value.used, appStore.byteDecimals))
const formattedMemoryTotal = computed(() => formatBytesSplit(totalMemory.value.total, appStore.byteDecimals))
const formattedDiskUsed = computed(() => formatBytesSplit(totalDisk.value.used, appStore.byteDecimals))
const formattedDiskTotal = computed(() => formatBytesSplit(totalDisk.value.total, appStore.byteDecimals))
const formattedSwapUsed = computed(() => formatBytesSplit(totalSwap.value.used, appStore.byteDecimals))
const formattedSwapTotal = computed(() => formatBytesSplit(totalSwap.value.total, appStore.byteDecimals))

const onlineNodeCount = computed(() => onlineNodes.value.length)
const totalNodeCount = computed(() => summaryNodes.value.length)
const avgCpu = computed(() => averageBy(onlineNodes.value, node => node.cpu))
const avgLoad = computed(() => averageBy(onlineNodes.value, node => node.load))
const avgLoad5 = computed(() => averageBy(onlineNodes.value, node => node.load5))
const avgLoad15 = computed(() => averageBy(onlineNodes.value, node => node.load15))
const totalProcesses = computed(() => onlineNodes.value.reduce((sum, node) => sum + (node.process || 0), 0))
const totalConnectionsTcp = computed(() => onlineNodes.value.reduce((sum, node) => sum + (node.connections || 0), 0))
const totalConnectionsUdp = computed(() => onlineNodes.value.reduce((sum, node) => sum + (node.connections_udp || 0), 0))
const totalCpuCores = computed(() => summaryNodes.value.reduce((sum, node) => sum + (node.cpu_cores || 0), 0))
const trafficQuota = computed(() => {
  let used = 0
  let limit = 0

  for (const node of summaryNodes.value) {
    if ((node.traffic_limit || 0) <= 0)
      continue
    used += getTrafficUsed(node)
    limit += node.traffic_limit || 0
  }

  return { used, limit }
})
const trafficQuotaPercentage = computed(() => {
  if (trafficQuota.value.limit <= 0)
    return 0
  return trafficQuota.value.used / trafficQuota.value.limit * 100
})

const trafficPeak = computed(() => getTopNodeBy(onlineNodes.value, getRealtimeTotalSpeed))
const uploadPeakNode = computed(() => getTopNodeBy(onlineNodes.value, node => node.net_out || 0))
const downloadPeakNode = computed(() => getTopNodeBy(onlineNodes.value, node => node.net_in || 0))
const connectionPeakNode = computed(() => getTopNodeBy(onlineNodes.value, getConnectionCount))
const offlineNodes = computed(() => summaryNodes.value.filter(node => !node.online))
const highLoadNodes = computed(() => onlineNodes.value.filter(node => isHighLoadNode(node, appStore.homeHighLoadThreshold)))
const expiringNodes = computed(() => summaryNodes.value.filter(node => isExpiringNode(node, appStore.homeExpiringDays)))
const trafficWarningNodes = computed(() => summaryNodes.value.filter(node => isTrafficWarningNode(node, appStore.homeTrafficWarningThreshold)))
const regionDistribution = computed(() => getDistribution(summaryNodes.value, node => node.region))
const systemDistribution = computed(() => getDistribution(summaryNodes.value, node => node.os))
const virtualizationDistribution = computed(() => getDistribution(summaryNodes.value, node => node.virtualization))
const monthlyCostCNY = computed(() => summaryNodes.value.reduce((sum, node) => sum + getNodePeriodCostCNY(node, 30), 0))
const yearlyCostCNY = computed(() => summaryNodes.value.reduce((sum, node) => sum + getNodePeriodCostCNY(node, 365), 0))

const remainingValueCNY = computed(() => {
  return financeHelper.calculateTotalRemainingValueCNY(summaryNodes.value, exchangeRates.value, excludeFreeNodes.value)
})
const remainingValue = computed(() => {
  const targetRate = exchangeRates.value[financeCurrency.value] || 1
  return remainingValueCNY.value * targetRate
})
const formattedRemainingValue = computed(() => {
  return financeHelper.formatFinanceAmount(remainingValue.value, financeCurrency.value)
})
const totalValueCNY = computed(() => {
  return financeHelper.calculateTotalValueCNY(summaryNodes.value, exchangeRates.value, excludeFreeNodes.value)
})
const totalValue = computed(() => {
  const targetRate = exchangeRates.value[financeCurrency.value] || 1
  return totalValueCNY.value * targetRate
})
const formattedTotalValue = computed(() => {
  return financeHelper.formatFinanceAmount(totalValue.value, financeCurrency.value)
})
const totalValueTooltip = computed(() => {
  if (!showPrice.value)
    return '总价值\n***'
  return `总价值\n${formattedTotalValue.value.symbol}${formattedTotalValue.value.value} ${formattedTotalValue.value.currency}`
})

const trafficPeakCard = computed(() => formatTopNodeSpeed(trafficPeak.value))
const uploadPeakCard = computed(() => formatTopNodeSpeed(uploadPeakNode.value))
const downloadPeakCard = computed(() => formatTopNodeSpeed(downloadPeakNode.value))
const connectionPeakTooltip = computed(() => {
  const metric = connectionPeakNode.value
  if (!metric)
    return '暂无数据'
  return `${metric.node.name}\nTCP ${formatCount(metric.node.connections || 0)}\nUDP ${formatCount(metric.node.connections_udp || 0)}`
})
const monthlyCostCard = computed(() => formatCostCard(monthlyCostCNY.value))
const yearlyCostCard = computed(() => formatCostCard(yearlyCostCNY.value))

const cardDefinitions = computed<Record<GeneralCardKey, GeneralMetricCard>>(() => ({
  memory: {
    key: 'memory',
    label: '内存用量',
    icon: 'icon-park-outline:memory',
    value: formattedMemoryUsed.value.value,
    unit: `${formattedMemoryUsed.value.unit} / ${formattedMemoryTotal.value.value} ${formattedMemoryTotal.value.unit}`,
  },
  disk: {
    key: 'disk',
    label: '硬盘用量',
    icon: 'tabler:server-2',
    value: formattedDiskUsed.value.value,
    unit: `${formattedDiskUsed.value.unit} / ${formattedDiskTotal.value.value} ${formattedDiskTotal.value.unit}`,
  },
  remainingValue: {
    key: 'remainingValue',
    label: '剩余价值',
    icon: 'tabler:cash',
    value: showPrice.value ? `${formattedRemainingValue.value.symbol}${formattedRemainingValue.value.value}` : '***',
    unit: showPrice.value ? formattedRemainingValue.value.currency : undefined,
    tooltip: totalValueTooltip.value,
  },
  totalTraffic: {
    key: 'totalTraffic',
    label: '累计流量',
    icon: 'tabler:download',
    value: totalTrafficTooltip.value.value,
    unit: totalTrafficTooltip.value.unit,
    tooltip: `↑ ${formattedTrafficUp.value.value} ${formattedTrafficUp.value.unit}\n↓ ${formattedTrafficDown.value.value} ${formattedTrafficDown.value.unit}`,
  },
  uploadSpeed: {
    key: 'uploadSpeed',
    label: '实时上行',
    icon: 'tabler:chevrons-up',
    value: formattedSpeedUp.value.value,
    unit: formattedSpeedUp.value.unit,
  },
  downloadSpeed: {
    key: 'downloadSpeed',
    label: '实时下行',
    icon: 'tabler:chevrons-down',
    value: formattedSpeedDown.value.value,
    unit: formattedSpeedDown.value.unit,
  },
  onlineNodes: {
    key: 'onlineNodes',
    label: '在线节点',
    icon: 'tabler:activity-heartbeat',
    value: formatCount(onlineNodeCount.value),
    unit: `/ ${formatCount(totalNodeCount.value)}`,
  },
  avgCpu: {
    key: 'avgCpu',
    label: '平均 CPU',
    icon: 'tabler:cpu',
    value: formatDecimal(avgCpu.value),
    unit: '%',
  },
  avgLoad: {
    key: 'avgLoad',
    label: '平均负载',
    icon: 'tabler:chart-line',
    value: formatDecimal(avgLoad.value, 2),
    tooltip: `1m ${formatDecimal(avgLoad.value, 2)}\n5m ${formatDecimal(avgLoad5.value, 2)}\n15m ${formatDecimal(avgLoad15.value, 2)}`,
  },
  swap: {
    key: 'swap',
    label: '交换内存',
    icon: 'icon-park-outline:switch',
    value: formattedSwapUsed.value.value,
    unit: `${formattedSwapUsed.value.unit} / ${formattedSwapTotal.value.value} ${formattedSwapTotal.value.unit}`,
  },
  processes: {
    key: 'processes',
    label: '进程总数',
    icon: 'tabler:list-numbers',
    value: formatCount(totalProcesses.value),
  },
  connections: {
    key: 'connections',
    label: '连接数',
    icon: 'tabler:plug-connected',
    value: formatCount(totalConnectionsTcp.value + totalConnectionsUdp.value),
    tooltip: `TCP ${formatCount(totalConnectionsTcp.value)}\nUDP ${formatCount(totalConnectionsUdp.value)}`,
  },
  cpuCores: {
    key: 'cpuCores',
    label: 'CPU 核心',
    icon: 'tabler:chip',
    value: formatCount(totalCpuCores.value),
    unit: 'Core',
  },
  trafficQuota: {
    key: 'trafficQuota',
    label: '流量配额',
    icon: 'tabler:gauge',
    value: trafficQuota.value.limit > 0 ? formatDecimal(trafficQuotaPercentage.value) : '-',
    unit: trafficQuota.value.limit > 0 ? '%' : undefined,
    tooltip: trafficQuota.value.limit > 0
      ? `${formatBytesText(trafficQuota.value.used)} / ${formatBytesText(trafficQuota.value.limit)}`
      : '无限流量',
  },
  trafficPeak: {
    key: 'trafficPeak',
    label: '实时峰值',
    icon: 'tabler:activity',
    value: trafficPeakCard.value.value,
    unit: trafficPeakCard.value.unit,
    tooltip: trafficPeakCard.value.tooltip,
  },
  uploadPeakNode: {
    key: 'uploadPeakNode',
    label: '上行最高',
    icon: 'tabler:arrow-big-up-lines',
    value: uploadPeakCard.value.value,
    unit: uploadPeakCard.value.unit,
    tooltip: uploadPeakCard.value.tooltip,
  },
  downloadPeakNode: {
    key: 'downloadPeakNode',
    label: '下行最高',
    icon: 'tabler:arrow-big-down-lines',
    value: downloadPeakCard.value.value,
    unit: downloadPeakCard.value.unit,
    tooltip: downloadPeakCard.value.tooltip,
  },
  offlineNodes: {
    key: 'offlineNodes',
    label: '离线节点',
    icon: 'tabler:plug-connected-x',
    value: formatCount(offlineNodes.value.length),
    unit: `/ ${formatCount(totalNodeCount.value)}`,
    tooltip: formatNodeNames(offlineNodes.value),
  },
  highLoadNodes: {
    key: 'highLoadNodes',
    label: '高负载节点',
    icon: 'tabler:alert-triangle',
    value: formatCount(highLoadNodes.value.length),
    unit: `/ ${formatCount(onlineNodeCount.value)}`,
    tooltip: formatNodeNames(highLoadNodes.value, (node) => {
      const metrics = getHighLoadMetrics(node, appStore.homeHighLoadThreshold)
      return `${node.name}: ${metrics.map(metric => `${metric.label} ${formatDecimal(metric.percentage)}%`).join(' / ')}`
    }),
  },
  expiringNodes: {
    key: 'expiringNodes',
    label: '即将到期',
    icon: 'tabler:calendar-exclamation',
    value: formatCount(expiringNodes.value.length),
    unit: '台',
    tooltip: formatNodeNames(expiringNodes.value, formatExpiryNode),
  },
  trafficWarnings: {
    key: 'trafficWarnings',
    label: '流量预警',
    icon: 'tabler:traffic-cone',
    value: formatCount(trafficWarningNodes.value.length),
    unit: '台',
    tooltip: formatNodeNames(trafficWarningNodes.value, node => `${node.name}: ${formatDecimal(getTrafficUsedPercentage(node))}%`),
  },
  connectionPeakNode: {
    key: 'connectionPeakNode',
    label: '连接峰值',
    icon: 'tabler:plug-connected',
    value: connectionPeakNode.value ? formatCount(connectionPeakNode.value.value) : '-',
    tooltip: connectionPeakTooltip.value,
  },
  regionDistribution: {
    key: 'regionDistribution',
    label: '地区分布',
    icon: 'tabler:map-pin',
    value: formatCount(regionDistribution.value.length),
    unit: '个',
    tooltip: formatDistributionTooltip(regionDistribution.value),
  },
  systemDistribution: {
    key: 'systemDistribution',
    label: '系统分布',
    icon: 'tabler:device-desktop',
    value: systemDistribution.value[0]?.[0] ?? '-',
    unit: systemDistribution.value[0] ? `${systemDistribution.value[0][1]} 台` : undefined,
    tooltip: formatDistributionTooltip(systemDistribution.value),
  },
  virtualizationDistribution: {
    key: 'virtualizationDistribution',
    label: '虚拟化',
    icon: 'tabler:box-multiple',
    value: virtualizationDistribution.value[0]?.[0] ?? '-',
    unit: virtualizationDistribution.value[0] ? `${virtualizationDistribution.value[0][1]} 台` : undefined,
    tooltip: formatDistributionTooltip(virtualizationDistribution.value),
  },
  monthlyCost: {
    key: 'monthlyCost',
    label: '月费用估算',
    icon: 'tabler:calendar-dollar',
    value: monthlyCostCard.value.value,
    unit: monthlyCostCard.value.unit,
  },
  yearlyCost: {
    key: 'yearlyCost',
    label: '年费用估算',
    icon: 'tabler:receipt-2',
    value: yearlyCostCard.value.value,
    unit: yearlyCostCard.value.unit,
  },
}))

const tiledDefaultCardKeys: GeneralCardKey[] = [
  'onlineNodes',
  'remainingValue',
  'monthlyCost',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
  'trafficPeak',
  'expiringNodes',
]
const baseVisibleCards = computed(() => appStore.generalCardOrder.map(key => cardDefinitions.value[key]))
const tiledDefaultCards = computed(() => tiledDefaultCardKeys.map(key => cardDefinitions.value[key]))
const showEarth = computed(() => !appStore.hideEarth)
const isTiledEarth = computed(() => showEarth.value && appStore.earthRenderer === 'tiled')
const visibleCards = computed(() => isTiledEarth.value ? tiledDefaultCards.value : baseVisibleCards.value)
const shouldRenderHeader = computed(() => showEarth.value || visibleCards.value.length > 0)
const hasExtraCards = computed(() => visibleCards.value.length > 6)
const wrapperClass = computed(() => {
  if (!showEarth.value)
    return 'p-4 grid grid-cols-1 gap-2 h-auto'

  if (isTiledEarth.value)
    return 'p-3 sm:p-4 grid grid-cols-12 gap-2 sm:gap-3 h-auto min-h-[40rem] sm:min-h-[30rem] md:min-h-[36rem] lg:min-h-[40rem]'

  return hasExtraCards.value
    ? 'p-4 grid grid-cols-12 gap-2 h-auto md:min-h-58'
    : 'p-4 grid grid-cols-12 grid-rows-1 gap-2 h-auto md:h-58'
})
const earthClass = computed(() => {
  if (isTiledEarth.value)
    return 'col-span-12 row-start-2 min-h-[18rem] h-[18rem] sm:h-[20rem] md:h-[24rem] lg:h-[28rem]'

  return 'col-span-12 col-start-1 md:col-span-6 md:col-start-7 md:row-start-1'
})
const cardGridClass = computed(() => {
  if (!showEarth.value)
    return 'col-span-1 grid grid-cols-3 md:grid-cols-6 gap-2'

  if (isTiledEarth.value)
    return 'col-span-12 row-start-1 z-9 grid grid-cols-12 auto-rows-[4.75rem] sm:auto-rows-[5rem] md:auto-rows-[5.8rem] gap-2 sm:gap-3'

  return hasExtraCards.value
    ? 'h-auto -mt-42 md:mt-0 col-span-12 row-start-3 z-9 md:h-auto md:col-span-6 md:row-start-1 grid grid-cols-12 auto-rows-[5rem] md:auto-rows-[7rem] gap-2'
    : 'h-42 -mt-42 md:mt-0 col-span-12 row-start-3 z-9 md:h-auto md:col-span-6 md:row-start-1 grid grid-cols-12 grid-rows-2 gap-2'
})
const cardClass = 'group relative z-10 h-full bg-background/50 border-none hover:bg-background backdrop-blur-sm md:backdrop-blur-none transition-all'
const cardPositionClasses = [
  'col-span-4 row-span-1 col-start-1 row-start-1',
  'col-span-4 row-span-1 col-start-1 row-start-2',
  'col-span-4 row-span-1 col-start-5 row-start-1',
  'col-span-4 row-span-1 col-start-5 row-start-2',
  'col-span-4 row-span-1 col-start-9 row-start-1',
  'col-span-4 row-span-1 col-start-9 row-start-2',
]
const tiledCardPositionClasses = [
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-1 row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-4 row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-7 row-start-2 sm:row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-10 row-start-2 sm:row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-1 row-start-3 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-4 row-start-3 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-7 row-start-4 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-10 row-start-4 sm:row-start-2',
]
const unitClass = 'text-[11px] md:text-xs font-medium text-muted-foreground truncate'

function getCardPositionClass(index: number): string {
  if (!showEarth.value)
    return 'col-span-1 min-h-18 md:min-h-28'

  if (isTiledEarth.value)
    return tiledCardPositionClasses[index] ?? 'col-span-6 sm:col-span-3 row-span-1'

  return cardPositionClasses[index] ?? 'col-span-4 row-span-1'
}

onMounted(async () => {
  financeCurrency.value = financeHelper.getStoredFinanceCurrency()
  excludeFreeNodes.value = financeHelper.shouldExcludeFreeNodes()

  const { rates, source } = await financeHelper.getDailyExchangeRates()
  exchangeRates.value = rates
  exchangeRateSource.value = source
})
</script>

<template>
  <div v-if="shouldRenderHeader" :class="wrapperClass">
    <NodeEarthGlobe
      v-if="showEarth"
      :nodes="globeNodes"
      :class="earthClass"
    />

    <div v-if="visibleCards.length > 0" :class="cardGridClass">
      <CardX
        v-for="(card, index) in visibleCards"
        :key="card.key"
        hoverable
        :class="[cardClass, getCardPositionClass(index)]"
        content-class="h-full !p-3"
      >
        <div class="flex h-full flex-col justify-between gap-1">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-medium tracking-wider text-muted-foreground truncate">{{ card.label }}</span>
            <Icon
              :icon="card.icon" :width="20" :height="20"
              class="shrink-0 text-slate-500/20 group-hover:text-slate-500 transition-colors"
            />
          </div>
          <DataTooltip
            as="span"
            placement="top"
            :content="card.tooltip"
            class="min-w-0"
            content-class="whitespace-pre px-2 py-1 left-0 -translate-x-0 leading-normal"
          >
            <Transition v-bind="metricSwitchTransitionProps">
              <div
                :key="`${card.key}-${summaryTransitionKey}`"
                class="flex items-baseline gap-1 min-w-0"
                :style="getMetricSwitchStyle(index)"
              >
                <span class="text-md md:text-2xl font-bold leading-none tracking-tight truncate">
                  {{ card.value }}
                </span>
                <span v-if="card.unit" :class="unitClass">
                  {{ card.unit }}
                </span>
              </div>
            </Transition>
          </DataTooltip>
        </div>
      </CardX>
    </div>
  </div>
</template>

<style scoped>
.metric-switch-enter-active,
.metric-switch-leave-active {
  transition:
    opacity 160ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 180ms ease;
}

.metric-switch-enter-active {
  transition-delay: var(--metric-switch-delay, 0ms);
}

.metric-switch-enter-from {
  opacity: 0;
  transform: translateY(6px);
  filter: blur(3px);
}

.metric-switch-leave-to {
  opacity: 0;
  transform: translateY(-4px);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .metric-switch-enter-active,
  .metric-switch-leave-active {
    transition: none;
    transition-delay: 0ms;
  }

  .metric-switch-enter-from,
  .metric-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
</style>
