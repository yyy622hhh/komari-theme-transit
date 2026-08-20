import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { OnlineNodeStats } from '@/utils/nodeMetricsHelper'
import { computed, toValue } from 'vue'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondSplit, formatBytesSplit } from '@/utils/helper'
import {
  computeOnlineNodeStats,
  getKnownNodeDistribution,
  getNodeDistribution,
  getTrafficUsed,
  isExpiringNode,
  isTrafficWarningNode,
} from '@/utils/nodeMetricsHelper'
import { getRegionDisplayName } from '@/utils/regionHelper'

/**
 * 首页汇总卡片的全部派生统计。
 *
 * 抽出来的直接原因是 `getCardDefinition` 要读 57 个散落的绑定，直接把它挪出组件
 * 就得传一个 57 字段的上下文——比留在原地更糟。先把「算数」收成一个对象，「怎么
 * 显示」才抽得动。
 *
 * 返回的是一组 computed 而不是一个 computed 出来的大对象：节点数据是就地按字段
 * 变更的，打包成单个对象会让任何一个字段变化都重算全部统计，正好抵消掉 store 那边
 * 特意保留的细粒度响应式。
 */
export function useNodeGeneralSummary(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const nodeList = computed(() => toValue(nodes))

  const onlineStats = computed<OnlineNodeStats>(() => computeOnlineNodeStats(nodeList.value, appStore.homeHighLoadThreshold))

  const totalSpeed = computed(() => onlineStats.value.totalSpeed)

  const totalTraffic = computed(() => {
    const up = nodeList.value.reduce((sum, node) => sum + (node.net_total_up || 0), 0)
    const down = nodeList.value.reduce((sum, node) => sum + (node.net_total_down || 0), 0)
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
    for (const node of nodeList.value) {
      used += node.ram || 0
      total += node.mem_total || 0
    }
    return { used, total }
  })

  const totalDisk = computed(() => {
    let used = 0
    let total = 0
    for (const node of nodeList.value) {
      used += node.disk || 0
      total += node.disk_total || 0
    }
    return { used, total }
  })

  const totalSwap = computed(() => {
    let used = 0
    let total = 0
    for (const node of nodeList.value) {
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

  const onlineNodeCount = computed(() => onlineStats.value.count)
  const totalNodeCount = computed(() => nodeList.value.length)
  const avgCpu = computed(() => onlineStats.value.avgCpu)
  const avgGpu = computed(() => onlineStats.value.gpuNodeCount > 0
    ? onlineStats.value.totalGpu / onlineStats.value.gpuNodeCount
    : null)
  const gpuNodes = computed(() => nodeList.value.filter(node => Boolean(node.gpu_name?.trim()) || (node.gpu || 0) > 0))
  const onlineGpuNodes = computed(() => gpuNodes.value.filter(node => node.online))
  const gpuPeakNode = computed(() => onlineStats.value.gpuPeakNode)
  const avgLoad = computed(() => onlineStats.value.avgLoad)
  const avgLoad5 = computed(() => onlineStats.value.avgLoad5)
  const avgLoad15 = computed(() => onlineStats.value.avgLoad15)
  const totalProcesses = computed(() => onlineStats.value.totalProcesses)
  const totalConnectionsTcp = computed(() => onlineStats.value.totalConnectionsTcp)
  const totalConnectionsUdp = computed(() => onlineStats.value.totalConnectionsUdp)
  const totalCpuCores = computed(() => nodeList.value.reduce((sum, node) => sum + (node.cpu_cores || 0), 0))
  const trafficQuota = computed(() => {
    let used = 0
    let limit = 0

    for (const node of nodeList.value) {
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

  const trafficPeak = computed(() => onlineStats.value.trafficPeak)
  const uploadPeakNode = computed(() => onlineStats.value.uploadPeakNode)
  const downloadPeakNode = computed(() => onlineStats.value.downloadPeakNode)
  const connectionPeakNode = computed(() => onlineStats.value.connectionPeakNode)
  const offlineNodes = computed(() => nodeList.value.filter(node => !node.online))
  const highLoadNodes = computed(() => onlineStats.value.highLoadNodes)
  const expiringNodes = computed(() => nodeList.value.filter(node => isExpiringNode(node, appStore.homeExpiringDays)))
  const trafficWarningNodes = computed(() => nodeList.value.filter(node => isTrafficWarningNode(node, appStore.homeTrafficWarningThreshold)))
  const regionDistribution = computed(() => getKnownNodeDistribution(nodeList.value, node => getRegionDisplayName(node.region)))
  const systemDistribution = computed(() => getNodeDistribution(nodeList.value, node => node.os))
  const virtualizationDistribution = computed(() => getNodeDistribution(nodeList.value, node => node.virtualization))

  return {
    onlineStats,
    totalSpeed,
    totalTraffic,
    formattedTrafficUp,
    formattedTrafficDown,
    totalTrafficTooltip,
    formattedSpeedUp,
    formattedSpeedDown,
    totalMemory,
    totalDisk,
    totalSwap,
    formattedMemoryUsed,
    formattedMemoryTotal,
    formattedDiskUsed,
    formattedDiskTotal,
    formattedSwapUsed,
    formattedSwapTotal,
    onlineNodeCount,
    totalNodeCount,
    avgCpu,
    avgGpu,
    gpuNodes,
    onlineGpuNodes,
    gpuPeakNode,
    avgLoad,
    avgLoad5,
    avgLoad15,
    totalProcesses,
    totalConnectionsTcp,
    totalConnectionsUdp,
    totalCpuCores,
    trafficQuota,
    trafficQuotaPercentage,
    trafficPeak,
    uploadPeakNode,
    downloadPeakNode,
    connectionPeakNode,
    offlineNodes,
    highLoadNodes,
    expiringNodes,
    trafficWarningNodes,
    regionDistribution,
    systemDistribution,
    virtualizationDistribution,
  }
}

export type NodeGeneralSummary = ReturnType<typeof useNodeGeneralSummary>
