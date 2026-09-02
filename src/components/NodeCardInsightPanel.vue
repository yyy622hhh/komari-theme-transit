<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed, ref } from 'vue'
import CarrierPingSamples from '@/components/CarrierPingSamples.vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { useAppStore } from '@/stores/app'
import { formatBytesWithConfig, getUptimeDays } from '@/utils/helper'
import { nodeCardPanelModeLabel, resolveNodeCardPanelMode } from '@/utils/nodeCardPanel'
import { getDiskPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { probeFailureRateColumnLabel, probeFailureRateExplanation } from '@/utils/pingCurrentState'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()

const config = computed(() => appStore.nodeCardPanels[props.node.uuid] ?? { mode: appStore.nodeCardPanelDefault })
const {
  carrierDisplays,
  carrierScopeLabel,
  freshnessTitle: carrierFreshnessTitle,
  loading: carrierStatsLoading,
  delayed: carrierStatsDelayed,
  stale: carrierStatsStale,
} = useNodeCarrierPingDisplay(() => props.node.uuid)
const carrierDetailsOpen = ref(false)
// 只统计实际匹配到任务的运营商，避免还没配置的分区把「未知」也算进混合判断。
const carrierProbeTypes = computed(() => carrierDisplays.value.filter(carrier => carrier.taskNames.length).map(carrier => carrier.probeType))
/** 三家协议一致时给出简短标签；混用或类型未知时留空，紧凑头部不堆多余文案。 */
const carrierProtocolLabel = computed(() => {
  const types = [...new Set(carrierProbeTypes.value)]
  return types.length === 1 && types[0] ? types[0].toUpperCase() : ''
})
const carrierFailureRateTitle = computed(() => probeFailureRateExplanation(carrierProbeTypes.value))
const carrierFailureRateColumnLabel = computed(() => probeFailureRateColumnLabel(carrierProbeTypes.value))
const carrierSampleDescription = computed(() => carrierProtocolLabel.value
  ? `最近 1 小时的 ${carrierProtocolLabel.value} Ping 样本。`
  : '最近 1 小时的 Ping 样本。')
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
const trafficLimitTypeLabel = computed(() => ({
  up: '仅上行',
  down: '仅下行',
  min: '较小方向',
  max: '较大方向',
  sum: '上下行合计',
})[props.node.traffic_limit_type] ?? '上下行合计')
const trafficHeadroomLabel = computed(() => {
  if (!hasTrafficLimit(props.node))
    return '未设置配额'
  if (trafficPercentage.value >= 90)
    return '配额紧张'
  if (trafficPercentage.value >= 70)
    return '注意用量'
  return '配额充足'
})
const trafficProgressTone = computed(() => {
  if (!hasTrafficLimit(props.node) || trafficPercentage.value < 70)
    return 'bg-emerald-500'
  return trafficPercentage.value >= 90 ? 'bg-rose-500' : 'bg-amber-500'
})
const storageHeadroomLabel = computed(() => {
  if (diskPercentage.value >= 90)
    return '空间紧张'
  if (diskPercentage.value >= 75)
    return '注意容量'
  return '空间充足'
})
const storageProgressTone = computed(() => {
  if (diskPercentage.value >= 90)
    return 'bg-rose-500'
  return diskPercentage.value >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
})

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
    class="node-card-insight col-span-full flex h-36 min-w-0 flex-col overflow-hidden px-2.5 py-2"
    :aria-label="`${node.name} ${panelLabel}`"
  >
    <template v-if="effectiveMode === 'carrier'">
      <div class="mb-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">
        <span class="min-w-0 font-medium text-slate-800 dark:text-slate-200">三网质量</span>
        <span class="truncate text-right text-[10px]" :title="`${carrierScopeLabel}${carrierProtocolLabel ? ` / ${carrierProtocolLabel}` : ''} / 近 1 小时；${carrierFreshnessTitle}`" :class="(carrierStatsDelayed || carrierStatsStale) && 'text-amber-700 dark:text-amber-300'">{{ carrierScopeLabel }}{{ carrierProtocolLabel ? ` / ${carrierProtocolLabel}` : '' }} · 近 1 小时</span>
        <button type="button" class="pointer-events-auto min-h-5 shrink-0 rounded-sm text-[10px] underline underline-offset-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500" aria-label="打开三网采样详情" @click.stop="carrierDetailsOpen = true">
          详情
        </button>
      </div>
      <div data-carrier-table-head class="carrier-summary-grid mb-0.5 text-[10px] leading-3 text-slate-500 dark:text-slate-400">
        <span class="col-start-2 text-right">Ping</span>
        <span class="col-start-3 text-right" :title="carrierFailureRateTitle">{{ carrierFailureRateColumnLabel }}</span>
      </div>
      <div class="space-y-0.5">
        <div v-for="carrier in carrierDisplays" :key="carrier.key" data-node-carrier-row class="min-w-0 text-[11px] leading-3.5">
          <div class="carrier-summary-grid" :data-probe-current="carrier.currentStatus">
            <span class="flex min-w-0 items-center gap-1 whitespace-nowrap text-slate-600 dark:text-slate-300"><i class="size-1 shrink-0 rounded-full" :class="carrier.dotClass" />{{ carrier.label }}</span>
            <strong class="min-w-0 truncate text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ carrier.latencyDisplay }}</strong>
            <strong
              class="min-w-0 truncate text-right font-medium tabular-nums"
              :class="lossTone(carrier.lossDisplay, carrier.commonModeLossEvents > 0 || carrier.currentStatus === 'healthy')"
              :data-carrier-target-incident="carrier.commonModeLossEvents > 0 ? '' : undefined"
              :title="carrier.lossTooltip"
            >{{ carrier.lossDisplay }}</strong>
          </div>
          <CarrierPingSamples class="carrier-compact-samples mt-px w-full" :bars="carrier.latencyBars.slice(-12)" :label="`${carrier.label}近一小时延迟`" />
        </div>
      </div>
    </template>

    <template v-else-if="effectiveMode === 'ping'">
      <div class="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
        <span>线路质量</span><span :class="customPingFreshnessDelayed && 'text-amber-700 dark:text-amber-300'">{{ customPingFreshnessLabel }}</span>
      </div>
      <div v-if="visibleCustomPingRows.length" class="grid flex-1 content-center gap-2">
        <div v-for="row in visibleCustomPingRows" :key="row.taskName.value" data-node-custom-ping-row class="grid min-w-0 grid-cols-[minmax(0,1fr)_58px_42px] items-center gap-1 text-[10px] leading-none">
          <span class="truncate text-slate-500 dark:text-slate-400" :title="row.taskName.value">{{ row.taskName.value }}</span>
          <strong class="text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ row.latency.value }}</strong>
          <strong class="text-right font-medium tabular-nums" :class="lossTone(row.loss.value)">{{ row.loss.value }}</strong>
        </div>
      </div>
      <p v-else class="grid flex-1 place-items-center text-[10px] text-slate-500 dark:text-slate-400">
        尚未选择 Ping 任务
      </p>
    </template>

    <template v-else>
      <div class="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
        <span>{{ panelLabel }}</span><span>{{ config.mode === 'auto' ? '自动' : '实时' }}</span>
      </div>

      <div v-if="effectiveMode === 'system'" class="grid flex-1 grid-cols-3 grid-rows-[minmax(0,1fr)_auto] gap-1 text-center text-[10px]">
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

      <div v-else-if="effectiveMode === 'traffic'" class="flex flex-1 flex-col justify-center gap-2 text-[10px]">
        <div class="grid grid-cols-3 gap-1 text-center">
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">配额状态</span><strong class="mt-1 block truncate">{{ trafficHeadroomLabel }}</strong>
          </div>
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">剩余额度</span><strong class="mt-1 block truncate tabular-nums">{{ hasTrafficLimit(node) ? formatBytes(trafficRemaining) : '不限' }}</strong>
          </div>
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">统计口径</span><strong class="mt-1 block truncate">{{ trafficLimitTypeLabel }}</strong>
          </div>
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>配额进度</span><strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ hasTrafficLimit(node) ? `${trafficPercentage.toFixed(1)}%` : '-' }}</strong>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-slate-500/10">
            <span class="block h-full rounded-full" :class="trafficProgressTone" :style="{ width: `${hasTrafficLimit(node) ? trafficPercentage : 0}%` }" />
          </div>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'storage'" class="flex flex-1 flex-col justify-center gap-2 text-[10px]">
        <div class="grid grid-cols-3 gap-1 text-center">
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">空间状态</span><strong class="mt-1 block truncate">{{ storageHeadroomLabel }}</strong>
          </div>
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">可用容量</span><strong class="mt-1 block truncate tabular-nums">{{ formatBytes(diskFree) }}</strong>
          </div>
          <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-1 py-2">
            <span class="block text-slate-500 dark:text-slate-400">总容量</span><strong class="mt-1 block truncate tabular-nums">{{ formatBytes(node.disk_total) }}</strong>
          </div>
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>容量余量</span><strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ (100 - diskPercentage).toFixed(1) }}%</strong>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-slate-500/10">
            <span class="block h-full rounded-full" :class="storageProgressTone" :style="{ width: `${Math.max(0, 100 - diskPercentage)}%` }" />
          </div>
        </div>
      </div>

      <div v-else-if="effectiveMode === 'gpu'" class="grid flex-1 grid-cols-[70px_minmax(0,1fr)] gap-1 text-[10px]">
        <div class="rounded-md bg-slate-500/[0.05] px-1 py-1.5 text-center">
          <span class="block text-slate-500 dark:text-slate-400">GPU</span><strong class="mt-1 block text-sm tabular-nums">{{ node.gpu > 0 || node.gpu_name ? `${node.gpu.toFixed(1)}%` : '-' }}</strong>
        </div>
        <div class="min-w-0 rounded-md bg-slate-500/[0.05] px-2 py-1.5">
          <span class="block text-slate-500 dark:text-slate-400">设备</span><strong class="mt-1 block truncate text-[10px]" :title="node.gpu_name || '未上报 GPU'">{{ node.gpu_name || '未上报 GPU' }}</strong><span class="mt-1 block text-slate-500 dark:text-slate-400">系统温度 {{ node.temp > 0 ? `${node.temp.toFixed(1)}°C` : '-' }}</span>
        </div>
      </div>

      <div v-else class="grid flex-1 grid-cols-3 gap-1 text-center text-[10px]">
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
  </section>

  <AppDialog
    v-model:open="carrierDetailsOpen"
    :title="`${node.name} · Ping 与丢包`"
    :description="carrierSampleDescription"
    content-class="max-w-xl"
    icon="tabler:activity-heartbeat"
  >
    <div data-carrier-details class="space-y-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
      <p class="rounded-lg border border-border/60 bg-background/35 px-3 py-2.5">
        {{ carrierFailureRateTitle }}
      </p>
      <article v-for="carrier in carrierDisplays" :key="carrier.key" class="rounded-xl border border-border/60 bg-background/30 p-3">
        <div class="flex items-center justify-between gap-3">
          <strong class="font-medium">{{ carrier.label }}</strong>
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ carrier.latencyDisplay }} · {{ carrier.lossDisplay }}</span>
        </div>
        <CarrierPingSamples class="mt-2 w-full" :bars="carrier.latencyBars" :label="`${carrier.label}近一小时延迟`" />
        <p class="mt-2 whitespace-pre-line break-words text-[11px] text-muted-foreground">
          {{ carrier.lossTooltip }}
        </p>
      </article>
    </div>
  </AppDialog>
</template>

<style scoped>
.node-card-insight {
  grid-column: 1 / -1;
  border: 1px solid var(--transit-divider);
  border-radius: 0.65rem;
  background: var(--transit-cell-bg);
}

.carrier-summary-grid {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr) 3.75rem;
  align-items: center;
  column-gap: 0.25rem;
}

.carrier-compact-samples :deep([data-sample-strip]) {
  height: 0.5rem;
}

.carrier-compact-samples :deep([data-sample-trigger]) {
  height: 0.5rem;
}

.carrier-compact-samples :deep([data-sample-trigger] > span) {
  height: 0.1875rem;
}
</style>
