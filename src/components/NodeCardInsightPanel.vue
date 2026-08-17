<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import CarrierPingSamples from '@/components/CarrierPingSamples.vue'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { useAppStore } from '@/stores/app'
import { formatBytesWithConfig, getUptimeDays } from '@/utils/helper'
import { nodeCardPanelModeLabel, resolveNodeCardPanelMode } from '@/utils/nodeCardPanel'
import { getDiskPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()

const config = computed(() => appStore.nodeCardPanels[props.node.uuid] ?? { mode: appStore.nodeCardPanelDefault })
const {
  carrierDisplays,
  carrierScopeLabel,
  loading: carrierStatsLoading,
  stale: carrierStatsStale,
} = useNodeCarrierPingDisplay(() => props.node.uuid)
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

function lossTone(loss: string): string {
  const value = Number.parseFloat(loss)
  if (!Number.isFinite(value) || value <= 1)
    return 'text-slate-700 dark:text-slate-300'
  if (value <= 3)
    return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-600 dark:text-rose-400'
}
</script>

<template>
  <section
    data-node-insight-panel
    :data-node-insight-mode="effectiveMode"
    class="node-card-insight h-24 min-w-0 overflow-hidden px-2.5 py-1.5"
    :aria-label="`${node.name} ${panelLabel}`"
  >
    <template v-if="effectiveMode === 'carrier'">
      <div class="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[9px] text-slate-500">
        <span>三网质量</span><span :class="carrierStatsStale && 'text-amber-700 dark:text-amber-300'">{{ carrierStatsStale ? `${carrierScopeLabel} 数据过期` : carrierScopeLabel }}</span>
      </div>
      <div class="space-y-1">
        <div v-for="carrier in carrierDisplays" :key="carrier.key" data-node-carrier-row class="grid min-w-0 grid-cols-[26px_minmax(24px,1fr)_minmax(38px,auto)_minmax(34px,auto)] items-center gap-1 text-[8px] leading-none">
          <span class="flex items-center gap-1 text-slate-500"><i class="size-1.5 rounded-full" :class="carrier.dotClass" />{{ carrier.label }}</span>
          <CarrierPingSamples :bars="carrier.latencyBars.slice(-12)" :label="`${carrier.label}延迟`" />
          <strong class="text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ carrier.latencyDisplay.replace(' ms', '') }}</strong>
          <strong class="text-right font-medium tabular-nums" :class="lossTone(carrier.lossDisplay)">{{ carrier.lossDisplay }}</strong>
        </div>
      </div>
    </template>

    <template v-else-if="effectiveMode === 'ping'">
      <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-slate-500">
        <span>线路质量</span><span>自定义 Ping</span>
      </div>
      <div v-if="visibleCustomPingRows.length" class="space-y-1">
        <div v-for="row in visibleCustomPingRows" :key="row.taskName.value" data-node-custom-ping-row class="grid min-w-0 grid-cols-[minmax(0,1fr)_52px_38px] items-center gap-1 text-[8px] leading-none">
          <span class="truncate text-slate-500" :title="row.taskName.value">{{ row.taskName.value }}</span>
          <strong class="text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ row.latency.value }}</strong>
          <strong class="text-right font-medium tabular-nums" :class="lossTone(row.loss.value)">{{ row.loss.value }}</strong>
        </div>
      </div>
      <p v-else class="grid min-h-11 place-items-center text-[9px] text-slate-500">
        尚未选择 Ping 任务
      </p>
    </template>

    <template v-else>
      <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-slate-500">
        <span>{{ panelLabel }}</span><span>{{ config.mode === 'auto' ? '自动' : '实时' }}</span>
      </div>

      <div v-if="effectiveMode === 'system'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">Load</span><strong class="mt-1 block truncate tabular-nums">{{ node.load.toFixed(2) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">温度</span><strong class="mt-1 block truncate tabular-nums">{{ node.temp > 0 ? `${node.temp.toFixed(1)}°C` : '-' }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">Swap</span><strong class="mt-1 block truncate tabular-nums">{{ node.swap_total > 0 ? `${swapPercentage.toFixed(1)}%` : '无' }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500">
          <span>进程 {{ node.process }}</span><span>连接 {{ totalConnections }}</span><span>Load5 {{ node.load5.toFixed(2) }}</span>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'traffic'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">累计上行</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.net_total_up) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">累计下行</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.net_total_down) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">剩余额度</span><strong class="mt-1 block break-words tabular-nums">{{ hasTrafficLimit(node) ? formatBytes(trafficRemaining) : '不限' }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500">
          <span>已用 {{ formatBytes(trafficUsed) }}</span><span>{{ hasTrafficLimit(node) ? `${trafficPercentage.toFixed(1)}%` : '未设置配额' }}</span>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'storage'" class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">已使用</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.disk) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">可用</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(diskFree) }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">总容量</span><strong class="mt-1 block break-words tabular-nums">{{ formatBytes(node.disk_total) }}</strong>
        </div>
        <div class="col-span-3 flex items-center justify-between px-1 text-slate-500">
          <span>磁盘占用</span><strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'gpu'" class="grid grid-cols-[70px_minmax(0,1fr)] gap-1 text-[8px]">
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5 text-center">
          <span class="block text-slate-500">GPU</span><strong class="mt-1 block text-sm tabular-nums">{{ node.gpu > 0 || node.gpu_name ? `${node.gpu.toFixed(1)}%` : '-' }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-2 py-1.5">
          <span class="block text-slate-500">设备</span><strong class="mt-1 block truncate text-[9px]" :title="node.gpu_name || '未上报 GPU'">{{ node.gpu_name || '未上报 GPU' }}</strong><span class="mt-1 block text-slate-500">系统温度 {{ node.temp > 0 ? `${node.temp.toFixed(1)}°C` : '-' }}</span>
        </div>
      </div>

      <div v-else class="grid grid-cols-3 gap-1 text-center text-[8px]">
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">在线</span><strong class="mt-1 block tabular-nums">{{ getUptimeDays(node.uptime) }} 天</strong>
        </div>
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">进程</span><strong class="mt-1 block tabular-nums">{{ node.process }}</strong>
        </div>
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5">
          <span class="block text-slate-500">连接</span><strong class="mt-1 block tabular-nums">{{ totalConnections }}</strong>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.node-card-insight {
  border: 1px solid var(--transit-divider);
  border-radius: 0.65rem;
  background: var(--transit-cell-bg);
}
</style>
