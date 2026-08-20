import type { ComputedRef } from 'vue'
import type { createNodeGeneralFormatters, GeneralMetricCard } from '@/components/nodeGeneralCards.helpers'
import type { useNodeGeneralFinance } from '@/composables/useNodeGeneralFinance'
import type { NodeGeneralSummary } from '@/composables/useNodeGeneralSummary'
import type { GeneralCardKey } from '@/stores/app'
import type { formatMetricDecimal, formatNodeCount, formatNodeNameList } from '@/utils/nodeMetricsHelper'
import {
  formatDistributionTooltip,
  formatExpiryNodeLine,
  getHighLoadMetrics,
  getTrafficUsedPercentage,
} from '@/utils/nodeMetricsHelper'

type NodeGeneralFinance = ReturnType<typeof useNodeGeneralFinance>
/** 峰值卡片的展示形状，由 createNodeGeneralFormatters 产出。 */
type TopNodeCard = ReturnType<ReturnType<typeof createNodeGeneralFormatters>['formatTopNodeSpeed']>

/**
 * 每张首页汇总卡片的展示定义。
 *
 * 从 NodeGeneralCards.vue 搬出来的是 274 行的一个纯映射：给定卡片 key 和一组已经
 * 算好的数值，返回它该显示什么。它长是因为卡片种类多，不是因为职责混乱——所以
 * 这里不再继续切分，只是让组件不必把它扛在身上。
 *
 * 上下文按来源分组传入，而不是 57 个散参数：正是那 57 个绑定让它此前抽不出去。
 */
export interface NodeGeneralCardContext {
  summary: NodeGeneralSummary
  /** 直接复用 useNodeGeneralFinance 的返回类型，避免在这里重新描述一遍金额结构。 */
  finance: NodeGeneralFinance
  /** 组件里算好的展示值：峰值卡、时间文本和需要跨字段拼装的 tooltip。 */
  derived: {
    trafficPeakCard: ComputedRef<TopNodeCard>
    uploadPeakCard: ComputedRef<TopNodeCard>
    downloadPeakCard: ComputedRef<TopNodeCard>
    gpuPeakCard: ComputedRef<TopNodeCard>
    currentTimeText: ComputedRef<string>
    currentDateText: ComputedRef<string>
    connectionPeakTooltip: ComputedRef<string>
  }
  format: {
    bytes: (bytes: number) => string
    count: typeof formatNodeCount
    decimal: typeof formatMetricDecimal
    nodeNames: typeof formatNodeNameList
  }
  showPrice: ComputedRef<boolean>
  highLoadThreshold: () => number
}

export function getNodeGeneralCardDefinition(key: GeneralCardKey, ctx: NodeGeneralCardContext): GeneralMetricCard {
  switch (key) {
    case 'currentTime':
      return {
        key: 'currentTime',
        label: '当前时间',
        icon: 'tabler:clock',
        value: ctx.derived.currentTimeText.value,
        tooltip: ctx.derived.currentDateText.value,
      }
    case 'memory':
      return {
        key: 'memory',
        label: '内存用量',
        icon: 'icon-park-outline:memory',
        value: ctx.summary.formattedMemoryUsed.value.value,
        unit: `${ctx.summary.formattedMemoryUsed.value.unit} / ${ctx.summary.formattedMemoryTotal.value.value} ${ctx.summary.formattedMemoryTotal.value.unit}`,
      }
    case 'disk':
      return {
        key: 'disk',
        label: '硬盘用量',
        icon: 'tabler:server-2',
        value: ctx.summary.formattedDiskUsed.value.value,
        unit: `${ctx.summary.formattedDiskUsed.value.unit} / ${ctx.summary.formattedDiskTotal.value.value} ${ctx.summary.formattedDiskTotal.value.unit}`,
      }
    case 'remainingValue':
      return {
        key: 'remainingValue',
        label: '剩余价值',
        icon: 'tabler:cash',
        value: ctx.showPrice.value ? `${ctx.finance.formattedRemainingValue.value.symbol}${ctx.finance.formattedRemainingValue.value.value}` : '***',
        tooltip: ctx.finance.totalValueTooltip.value,
        action: ctx.showPrice.value ? 'financeDetails' : undefined,
      }
    case 'totalTraffic':
      return {
        key: 'totalTraffic',
        label: '累计流量',
        icon: 'tabler:download',
        value: ctx.summary.totalTrafficTooltip.value.value,
        unit: ctx.summary.totalTrafficTooltip.value.unit,
        tooltip: `↑ ${ctx.summary.formattedTrafficUp.value.value} ${ctx.summary.formattedTrafficUp.value.unit}\n↓ ${ctx.summary.formattedTrafficDown.value.value} ${ctx.summary.formattedTrafficDown.value.unit}`,
      }
    case 'uploadSpeed':
      return {
        key: 'uploadSpeed',
        label: '实时上行',
        icon: 'tabler:chevrons-up',
        value: ctx.summary.formattedSpeedUp.value.value,
        unit: ctx.summary.formattedSpeedUp.value.unit,
      }
    case 'downloadSpeed':
      return {
        key: 'downloadSpeed',
        label: '实时下行',
        icon: 'tabler:chevrons-down',
        value: ctx.summary.formattedSpeedDown.value.value,
        unit: ctx.summary.formattedSpeedDown.value.unit,
      }
    case 'onlineNodes':
      return {
        key: 'onlineNodes',
        label: '在线节点',
        icon: 'tabler:activity-heartbeat',
        value: ctx.format.count(ctx.summary.onlineNodeCount.value),
        unit: `/ ${ctx.format.count(ctx.summary.totalNodeCount.value)}`,
      }
    case 'avgCpu':
      return {
        key: 'avgCpu',
        label: '平均 CPU',
        icon: 'tabler:cpu',
        value: ctx.format.decimal(ctx.summary.avgCpu.value),
        unit: '%',
      }
    case 'avgGpu':
      return {
        key: 'avgGpu',
        label: '平均 GPU',
        icon: 'tabler:device-desktop-analytics',
        value: ctx.summary.avgGpu.value === null ? '-' : ctx.format.decimal(ctx.summary.avgGpu.value),
        unit: ctx.summary.avgGpu.value === null ? undefined : '%',
        tooltip: ctx.format.nodeNames(ctx.summary.onlineGpuNodes.value, node => `${node.name}: ${ctx.format.decimal(node.gpu || 0)}%`),
      }
    case 'avgLoad':
      return {
        key: 'avgLoad',
        label: '平均负载',
        icon: 'tabler:chart-line',
        value: ctx.format.decimal(ctx.summary.avgLoad.value, 2),
        tooltip: `1m ${ctx.format.decimal(ctx.summary.avgLoad.value, 2)}\n5m ${ctx.format.decimal(ctx.summary.avgLoad5.value, 2)}\n15m ${ctx.format.decimal(ctx.summary.avgLoad15.value, 2)}`,
      }
    case 'swap':
      return {
        key: 'swap',
        label: '交换内存',
        icon: 'icon-park-outline:switch',
        value: ctx.summary.formattedSwapUsed.value.value,
        unit: `${ctx.summary.formattedSwapUsed.value.unit} / ${ctx.summary.formattedSwapTotal.value.value} ${ctx.summary.formattedSwapTotal.value.unit}`,
      }
    case 'processes':
      return {
        key: 'processes',
        label: '进程总数',
        icon: 'tabler:list-numbers',
        value: ctx.format.count(ctx.summary.totalProcesses.value),
      }
    case 'connections':
      return {
        key: 'connections',
        label: '连接数',
        icon: 'tabler:plug-connected',
        value: ctx.format.count(ctx.summary.totalConnectionsTcp.value + ctx.summary.totalConnectionsUdp.value),
        tooltip: `TCP ${ctx.format.count(ctx.summary.totalConnectionsTcp.value)}\nUDP ${ctx.format.count(ctx.summary.totalConnectionsUdp.value)}`,
      }
    case 'cpuCores':
      return {
        key: 'cpuCores',
        label: 'CPU 核心',
        icon: 'tabler:cpu',
        value: ctx.format.count(ctx.summary.totalCpuCores.value),
        unit: 'Core',
      }
    case 'gpuNodes':
      return {
        key: 'gpuNodes',
        label: 'GPU 节点',
        icon: 'tabler:device-imac',
        value: ctx.format.count(ctx.summary.gpuNodes.value.length),
        unit: `/ ${ctx.format.count(ctx.summary.totalNodeCount.value)}`,
        tooltip: ctx.format.nodeNames(ctx.summary.gpuNodes.value, node => `${node.name}: ${node.gpu_name?.trim() || 'GPU'}`),
      }
    case 'gpuPeakNode':
      return {
        key: 'gpuPeakNode',
        label: 'GPU 峰值',
        icon: 'tabler:chart-histogram',
        value: ctx.derived.gpuPeakCard.value.value,
        unit: ctx.derived.gpuPeakCard.value.unit,
        tooltip: ctx.derived.gpuPeakCard.value.tooltip,
      }
    case 'trafficQuota':
      return {
        key: 'trafficQuota',
        label: '流量配额',
        icon: 'tabler:gauge',
        value: ctx.summary.trafficQuota.value.limit > 0 ? ctx.format.decimal(ctx.summary.trafficQuotaPercentage.value) : '-',
        unit: ctx.summary.trafficQuota.value.limit > 0 ? '%' : undefined,
        tooltip: ctx.summary.trafficQuota.value.limit > 0
          ? `${ctx.format.bytes(ctx.summary.trafficQuota.value.used)} / ${ctx.format.bytes(ctx.summary.trafficQuota.value.limit)}`
          : '无限流量',
      }
    case 'trafficPeak':
      return {
        key: 'trafficPeak',
        label: '实时峰值',
        icon: 'tabler:activity',
        value: ctx.derived.trafficPeakCard.value.value,
        unit: ctx.derived.trafficPeakCard.value.unit,
        tooltip: ctx.derived.trafficPeakCard.value.tooltip,
      }
    case 'uploadPeakNode':
      return {
        key: 'uploadPeakNode',
        label: '上行最高',
        icon: 'tabler:arrow-big-up-lines',
        value: ctx.derived.uploadPeakCard.value.value,
        unit: ctx.derived.uploadPeakCard.value.unit,
        tooltip: ctx.derived.uploadPeakCard.value.tooltip,
      }
    case 'downloadPeakNode':
      return {
        key: 'downloadPeakNode',
        label: '下行最高',
        icon: 'tabler:arrow-big-down-lines',
        value: ctx.derived.downloadPeakCard.value.value,
        unit: ctx.derived.downloadPeakCard.value.unit,
        tooltip: ctx.derived.downloadPeakCard.value.tooltip,
      }
    case 'offlineNodes':
      return {
        key: 'offlineNodes',
        label: '离线节点',
        icon: 'tabler:plug-connected-x',
        value: ctx.format.count(ctx.summary.offlineNodes.value.length),
        unit: `/ ${ctx.format.count(ctx.summary.totalNodeCount.value)}`,
        tooltip: ctx.format.nodeNames(ctx.summary.offlineNodes.value),
      }
    case 'highLoadNodes':
      return {
        key: 'highLoadNodes',
        label: '高负载节点',
        icon: 'tabler:alert-triangle',
        value: ctx.format.count(ctx.summary.highLoadNodes.value.length),
        unit: `/ ${ctx.format.count(ctx.summary.onlineNodeCount.value)}`,
        tooltip: ctx.format.nodeNames(ctx.summary.highLoadNodes.value, (node) => {
          const metrics = getHighLoadMetrics(node, ctx.highLoadThreshold())
          return `${node.name}: ${metrics.map(metric => `${metric.label} ${ctx.format.decimal(metric.percentage)}%`).join(' / ')}`
        }),
      }
    case 'expiringNodes':
      return {
        key: 'expiringNodes',
        label: '即将到期',
        icon: 'tabler:calendar-exclamation',
        value: ctx.format.count(ctx.summary.expiringNodes.value.length),
        unit: '台',
        tooltip: ctx.format.nodeNames(ctx.summary.expiringNodes.value, formatExpiryNodeLine),
      }
    case 'trafficWarnings':
      return {
        key: 'trafficWarnings',
        label: '流量预警',
        icon: 'tabler:traffic-cone',
        value: ctx.format.count(ctx.summary.trafficWarningNodes.value.length),
        unit: '台',
        tooltip: ctx.format.nodeNames(ctx.summary.trafficWarningNodes.value, node => `${node.name}: ${ctx.format.decimal(getTrafficUsedPercentage(node))}%`),
      }
    case 'connectionPeakNode':
      return {
        key: 'connectionPeakNode',
        label: '连接峰值',
        icon: 'tabler:plug-connected',
        value: ctx.summary.connectionPeakNode.value ? ctx.format.count(ctx.summary.connectionPeakNode.value.value) : '-',
        tooltip: ctx.derived.connectionPeakTooltip.value,
      }
    case 'regionDistribution':
      return {
        key: 'regionDistribution',
        label: '地区分布',
        icon: 'tabler:map-pin',
        value: ctx.format.count(ctx.summary.regionDistribution.value.length),
        unit: '个',
        tooltip: formatDistributionTooltip(ctx.summary.regionDistribution.value),
      }
    case 'systemDistribution':
      return {
        key: 'systemDistribution',
        label: '系统分布',
        icon: 'tabler:device-desktop',
        value: ctx.summary.systemDistribution.value[0]?.[0] ?? '-',
        unit: ctx.summary.systemDistribution.value[0] ? `${ctx.summary.systemDistribution.value[0][1]} 台` : undefined,
        tooltip: formatDistributionTooltip(ctx.summary.systemDistribution.value),
      }
    case 'virtualizationDistribution':
      return {
        key: 'virtualizationDistribution',
        label: '虚拟化',
        icon: 'tabler:box-multiple',
        value: ctx.summary.virtualizationDistribution.value[0]?.[0] ?? '-',
        unit: ctx.summary.virtualizationDistribution.value[0] ? `${ctx.summary.virtualizationDistribution.value[0][1]} 台` : undefined,
        tooltip: formatDistributionTooltip(ctx.summary.virtualizationDistribution.value),
      }
    case 'monthlyCost':
      return {
        key: 'monthlyCost',
        label: '月费用估算',
        icon: 'tabler:calendar-dollar',
        value: ctx.finance.monthlyCostCard.value.value,
        unit: ctx.finance.monthlyCostCard.value.unit,
      }
    case 'yearlyCost':
      return {
        key: 'yearlyCost',
        label: '年费用估算',
        icon: 'tabler:receipt-2',
        value: ctx.finance.yearlyCostCard.value.value,
        unit: ctx.finance.yearlyCostCard.value.unit,
      }
    default:
      return getNodeGeneralCardDefinition('memory', ctx)
  }
}
