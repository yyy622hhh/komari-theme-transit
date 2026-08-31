<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed, ref, useId } from 'vue'
import CarrierPingSamples from '@/components/CarrierPingSamples.vue'
import NodeRoutePanel from '@/components/NodeRoutePanel.vue'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { useAppStore } from '@/stores/app'
import { formatBytesWithConfig, getUptimeDays } from '@/utils/helper'
import { nodeCardPanelModeLabel, resolveNodeCardPanelMode } from '@/utils/nodeCardPanel'
import { getDiskPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { probeCurrentTone } from '@/utils/pingCurrentState'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()

const config = computed(() => appStore.nodeCardPanels[props.node.uuid] ?? { mode: appStore.nodeCardPanelDefault })
const {
  carrierDisplays,
  carrierScopeLabel,
  freshnessLabel: carrierFreshnessLabel,
  freshnessTitle: carrierFreshnessTitle,
  loading: carrierStatsLoading,
  delayed: carrierStatsDelayed,
  stale: carrierStatsStale,
} = useNodeCarrierPingDisplay(() => props.node.uuid)
const carrierDetailsOpen = ref(false)
const carrierDetailsId = useId()
const carrierProtocolLabel = computed(() => {
  const types = [...new Set(carrierDisplays.value.filter(carrier => carrier.taskNames.length).map(carrier => carrier.probeType))]
  if (!types.length || types.includes(''))
    return '类型未报告'
  return types.length === 1 ? types[0]!.toUpperCase() : '混合探测'
})
const carrierSummaryLabel = computed(() => {
  if (carrierDisplays.value.some(carrier => Number.parseFloat(carrier.lossDisplay) > 0))
    return '近 1 小时曾异常'
  const states = carrierDisplays.value.map(carrier => carrier.currentStatus)
  if (states.includes('offline'))
    return '探测来源离线'
  if (states.includes('failed'))
    return '近期持续失败'
  if (states.includes('intermittent'))
    return '近期有间歇失败'
  if (states.includes('stale'))
    return '近期样本已过期'
  if (states.includes('insufficient'))
    return '近期证据不足'
  return '近期探测正常'
})
const carrierTasksAvailable = computed(() => carrierDisplays.value.some(carrier => carrier.taskNames.length > 0))
const effectiveMode = computed(() => resolveNodeCardPanelMode(
  props.node,
  config.value,
  carrierTasksAvailable.value,
  carrierStatsLoading.value,
))
const panelLabel = computed(() => nodeCardPanelModeLabel(effectiveMode.value))

const pingStatsEnabled = computed(() => effectiveMode.value === 'ping'
  && appStore.publicSettings?.record_enabled !== false
  && appStore.publicSettings?.ping_record_preserve_time !== 0)
const pingStatsHours = computed(() => {
  const preserveTime = appStore.publicSettings?.ping_record_preserve_time
  return typeof preserveTime === 'number' && preserveTime > 0 ? Math.min(preserveTime, 1) : 1
})
const customPingRows = Array.from({ length: 3 }, (_, index) => {
  const taskName = computed(() => config.value.pingTasks?.[index] ?? '')
  const ping = useNodePingStats(() => props.node.uuid, {
    hours: pingStatsHours,
    enabled: () => pingStatsEnabled.value && Boolean(taskName.value),
    maxCount: PING_SUMMARY_MAX_COUNT,
    taskNameFilter: taskName,
    taskNameMatch: 'exact',
  })
  return {
    taskName,
    loading: ping.loading,
    delayed: ping.delayed,
    stale: ping.stale,
    latency: computed(() => ping.stale.value
      ? '过期'
      : ping.hasData.value
        ? `${Math.round(ping.avgLatency.value)} ms`
        : ping.loading.value ? '加载中' : '-'),
    loss: computed(() => ping.stale.value
      ? '-'
      : ping.hasData.value
        ? `${ping.avgLoss.value.toFixed(1)}%`
        : ping.loading.value ? '…' : '-'),
  }
})
const visibleCustomPingRows = computed(() => customPingRows.filter(row => row.taskName.value))
const customPingFreshnessLabel = computed(() => {
  if (visibleCustomPingRows.value.some(row => row.stale.value))
    return '数据过期'
  if (visibleCustomPingRows.value.some(row => row.delayed.value))
    return '可能不是最新'
  return '自定义 Ping'
})
const customPingFreshnessDelayed = computed(() => visibleCustomPingRows.value.some(row => row.delayed.value || row.stale.value))

const diskPercentage = computed(() => getDiskPercentage(props.node))
const diskFree = computed(() => Math.max(0, props.node.disk_total - props.node.disk))
const trafficUsed = computed(() => getTrafficUsed(props.node))
const trafficPercentage = computed(() => getTrafficUsedPercentage(props.node))
const trafficRemaining = computed(() => hasTrafficLimit(props.node)
  ? Math.max(0, props.node.traffic_limit - trafficUsed.value)
  : 0)
const swapPercentage = computed(() => props.node.swap_total > 0
  ? Math.min(100, Math.max(0, props.node.swap / props.node.swap_total * 100))
  : 0)
const totalConnections = computed(() => Math.max(0, props.node.connections) + Math.max(0, props.node.connections_udp))
const formatBytes = (value: number) => formatBytesWithConfig(value || 0, appStore.byteDecimals)

function lossTone(loss: string, commonMode = false): string {
  const value = Number.parseFloat(loss)
  if (!Number.isFinite(value) || value <= 1)
    return 'text-slate-700 dark:text-slate-300'
  if (commonMode || value <= 3)
    return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-600 dark:text-rose-400'
}
</script>

<template>
  <section
    data-node-insight-panel
    :data-node-insight-mode="effectiveMode"
    class="node-card-insight min-w-0"
    :class="effectiveMode === 'carrier' ? 'py-1' : 'min-h-24 py-2'"
    :aria-label="`${node.name} ${panelLabel}`"
  >
    <template v-if="effectiveMode === 'carrier'">
      <div class="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span class="font-semibold text-foreground">三网质量</span>
        <span class="text-muted-foreground" :title="carrierFreshnessTitle" :class="(carrierStatsDelayed || carrierStatsStale) && 'text-amber-700 dark:text-amber-300'">{{ carrierScopeLabel }} · {{ carrierProtocolLabel }}</span>
      </div>
      <div data-carrier-table-head class="mb-4 text-[11px] leading-4 text-muted-foreground">
        <span>近 1 小时均值</span>
        <span class="sr-only">与历史失败率；当前状态独立判断</span>
      </div>
      <div data-carrier-columns class="grid grid-cols-3 gap-3">
        <div v-for="carrier in carrierDisplays" :key="carrier.key" data-node-carrier-row class="min-w-0">
          <div class="carrier-summary-grid">
            <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><i class="size-1.5 shrink-0 rounded-full" :class="carrier.dotClass" /><span>{{ carrier.label }}</span></span>
            <div class="carrier-latency mt-2 flex min-w-0 items-baseline gap-1" :title="carrier.latencyTooltip">
              <strong class="min-w-0 break-words font-semibold tabular-nums tracking-tight text-foreground" :class="/^\d/.test(carrier.latencyDisplay) ? 'carrier-latency__number' : 'text-base'">{{ carrier.latencyDisplay.replace(/ ms$/, '') }}</strong>
              <span v-if="/^\d/.test(carrier.latencyDisplay)" class="text-[10px] text-muted-foreground">ms</span>
            </div>
            <div class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1 text-[11px] leading-4 text-muted-foreground" :title="carrier.lossTooltip">
              <span>{{ carrier.probeType === 'icmp' ? '丢包率' : '失败率' }}</span>
              <strong class="min-w-0 break-words font-medium tabular-nums" :class="lossTone(carrier.lossDisplay, carrier.commonModeLossEvents > 0 || carrier.currentStatus === 'healthy')" :data-carrier-target-incident="carrier.commonModeLossEvents > 0 ? '' : undefined" :title="carrier.lossTooltip">{{ carrier.lossDisplay }}</strong>
            </div>
            <div class="mt-2 flex min-h-5 min-w-0 items-start gap-1.5 text-[11px] leading-4" :class="probeCurrentTone(carrier.currentStatus)" :title="carrier.currentLabel">
              <span aria-hidden="true" class="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" />
              <span class="min-w-0 break-words font-medium" :data-probe-current="carrier.currentStatus" :title="carrier.lossTooltip">{{ carrier.currentCompactLabel }}</span>
            </div>
          </div>
          <CarrierPingSamples class="mt-2 w-full" :bars="carrier.latencyBars.slice(-12)" :label="`${carrier.label}近一小时延迟`" />
        </div>
      </div>
      <NodeRoutePanel class="mt-3" :tags="node.tags" compact />
      <div class="transit-divider mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-1.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">
        <span :title="`${carrierFreshnessLabel}；${carrierFreshnessTitle}`">{{ carrierSummaryLabel }}</span>
        <button type="button" class="pointer-events-auto min-h-6 rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500" :aria-expanded="carrierDetailsOpen" :aria-controls="carrierDetailsId" @click.stop="carrierDetailsOpen = !carrierDetailsOpen">
          {{ carrierDetailsOpen ? '收起详情' : '采样详情' }}
        </button>
      </div>
      <div v-if="carrierDetailsOpen" :id="carrierDetailsId" data-carrier-details class="transit-divider pointer-events-auto mt-2 space-y-3 border-t pt-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
        <p>TCP 探测失败率不代表业务流量丢包；当前状态与近 1 小时统计独立判断。</p>
        <div v-for="carrier in carrierDisplays" :key="carrier.key">
          <strong class="font-medium" :class="probeCurrentTone(carrier.currentStatus)">{{ carrier.label }}：{{ carrier.currentLabel }}</strong>
          <p class="mt-1 whitespace-pre-line break-words">
            {{ carrier.lossTooltip }}
          </p>
        </div>
      </div>
    </template>

    <template v-else-if="effectiveMode === 'ping'">
      <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-slate-500 dark:text-slate-400">
        <span>线路质量</span><span :class="customPingFreshnessDelayed && 'text-amber-700 dark:text-amber-300'">{{ customPingFreshnessLabel }}</span>
      </div>
      <div v-if="visibleCustomPingRows.length" class="space-y-1">
        <div v-for="row in visibleCustomPingRows" :key="row.taskName.value" data-node-custom-ping-row class="grid min-w-0 grid-cols-[minmax(0,1fr)_52px_38px] items-center gap-1 text-[8px] leading-none">
          <span class="truncate text-slate-500 dark:text-slate-400" :title="row.taskName.value">{{ row.taskName.value }}</span>
          <strong class="text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ row.latency.value }}</strong>
          <strong class="text-right font-medium tabular-nums" :class="lossTone(row.loss.value)">{{ row.loss.value }}</strong>
        </div>
      </div>
      <p v-else class="grid min-h-11 place-items-center text-[9px] text-slate-500 dark:text-slate-400">
        尚未选择 Ping 任务
      </p>
    </template>

    <template v-else>
      <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-slate-500 dark:text-slate-400">
        <span>{{ panelLabel }}</span><span>{{ config.mode === 'auto' ? '自动' : '实时' }}</span>
      </div>

      <div v-if="effectiveMode === 'system'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">Load</span><strong class="mt-1 block truncate tabular-nums">{{ (node.load ?? 0).toFixed(2) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">温度</span><strong class="mt-1 block truncate tabular-nums">{{ node.temp > 0 ? `${node.temp.toFixed(1)}°C` : '-' }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">Swap</span><strong class="mt-1 block truncate tabular-nums">{{ node.swap_total > 0 ? `${swapPercentage.toFixed(1)}%` : '无' }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500 dark:text-slate-400">
          <span>进程 {{ node.process }}</span><span>连接 {{ totalConnections }}</span><span>Load5 {{ (node.load5 ?? 0).toFixed(2) }}</span>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'traffic'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">累计上行</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.net_total_up) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">累计下行</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.net_total_down) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">剩余额度</span><strong class="mt-1 block break-words tabular-nums">{{ hasTrafficLimit(node) ? formatBytes(trafficRemaining) : '不限' }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500 dark:text-slate-400">
          <span>已用 {{ formatBytes(trafficUsed) }}</span><span>{{ hasTrafficLimit(node) ? `${trafficPercentage.toFixed(1)}%` : '未设置配额' }}</span>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'storage'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">已使用</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.disk) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">可用</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(diskFree) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">总容量</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.disk_total) }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500 dark:text-slate-400">
          <span>磁盘占用</span><strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'gpu'" class="grid grid-cols-[70px_minmax(0,1fr)] gap-1 text-[8px]">
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5 text-center">
          <span class="block text-slate-500 dark:text-slate-400">GPU</span><strong class="mt-1 block text-sm tabular-nums">{{ node.gpu > 0 || node.gpu_name ? `${node.gpu.toFixed(1)}%` : '-' }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-2 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">设备</span><strong class="mt-1 block truncate text-[9px]" :title="node.gpu_name || '未上报 GPU'">{{ node.gpu_name || '未上报 GPU' }}</strong><span class="mt-1 block text-slate-500 dark:text-slate-400">系统温度 {{ node.temp > 0 ? `${node.temp.toFixed(1)}°C` : '-' }}</span>
        </div>
      </div>

      <div v-else class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">在线</span><strong class="mt-1 block tabular-nums">{{ getUptimeDays(node.uptime) }} 天</strong>
        </div>
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">进程</span><strong class="mt-1 block tabular-nums">{{ node.process }}</strong>
        </div>
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">连接</span><strong class="mt-1 block tabular-nums">{{ totalConnections }}</strong>
        </div>
      </div>
    </template>
    <NodeRoutePanel v-if="effectiveMode !== 'carrier'" class="mt-4" :tags="node.tags" compact />
  </section>
</template>

<style scoped>
.node-card-insight {
  color: var(--transit-text-secondary);
}

.carrier-summary-grid {
  min-width: 0;
}

.carrier-latency__number {
  font-size: clamp(1.25rem, 7.5cqi, 2rem);
  line-height: 1.2;
}

@container (max-width: 19rem) {
  [data-carrier-columns] {
    gap: 0.5rem;
  }
}
</style>
