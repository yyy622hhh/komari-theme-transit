<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TelemetrySample } from '@/types/telemetry'
import type { TopologyRouteHealth } from '@/utils/topologyHealth'
import type { TopologyReliabilityWindow } from '@/utils/topologyIntelligence'
import { computed } from 'vue'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatDateTime } from '@/utils/helper'
import { resolveTopologySegmentHealth } from '@/utils/topologyHealth'
import { calculateTopologyLatencyBaseline, formatTopologyLatency, formatTopologyLoss, resolveTopologyMetricSource, resolveTopologySampleTone } from '@/utils/topologyHelper'
import { calculateAdaptiveBaseline } from '@/utils/topologyIntelligence'
import { formatTopologyTelemetryLabel, parseTopologyMetric } from '@/utils/topologyLegacyFormat'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  sourceLabel: string
  targetLabel: string
  hours: number
  sourceUuid?: string
}>()

const config = computed(() => parseTopologyMetric(props.metric))
const telemetryLabel = computed(() => formatTopologyTelemetryLabel(props.metric, props.sourceLabel, props.targetLabel))
const sourceNode = computed(() => resolveTopologyMetricSource(props.nodes, config.value.nodeName, props.sourceUuid))
const ping = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: () => props.hours,
    maxCount: 240,
    enabled: () => config.value.live && sourceNode.value?.online !== false && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const currentPing = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 1,
    maxCount: 240,
    enabled: () => config.value.live && sourceNode.value?.online !== false && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const baselinePing = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 24,
    maxCount: 240,
    enabled: () => config.value.live && sourceNode.value?.online !== false && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const hasLiveData = computed(() => config.value.live && ping.hasData.value && !ping.stale.value)
const latency = computed(() => hasLiveData.value
  ? (ping.hasLatencyData.value ? ping.avgLatency.value : null)
  : config.value.fallbackLatency)
const latencyText = computed(() => hasLiveData.value && !ping.hasLatencyData.value ? '无响应' : formatTopologyLatency(latency.value))
const loss = computed(() => hasLiveData.value ? ping.avgLoss.value : config.value.fallbackLoss)
const history = computed(() => ping.history.value.slice(-20))
const maximumLatency = computed(() => Math.max(...history.value.map(point => point.latency ?? 0), 1))
const baselineLatency = computed(() => calculateTopologyLatencyBaseline(history.value.map(point => point.latency)))
const health = computed<TopologyRouteHealth>(() => resolveTopologySegmentHealth({
  live: config.value.live,
  sourceExists: Boolean(sourceNode.value),
  sourceOnline: sourceNode.value?.online,
  loading: ping.loading.value,
  error: ping.error.value,
  stale: ping.stale.value,
  hasData: ping.hasData.value,
  avgLatency: ping.hasLatencyData.value ? ping.avgLatency.value : null,
  avgLoss: ping.avgLoss.value,
  avgVolatility: ping.avgVolatility.value,
  fallbackLatency: config.value.fallbackLatency,
  fallbackLoss: config.value.fallbackLoss,
}))
const baselineWindow = computed<TopologyReliabilityWindow>(() => ({
  hours: 24,
  availability: baselinePing.hasData.value ? baselinePing.availability.value : null,
  avgLatency: baselinePing.hasLatencyData.value ? baselinePing.avgLatency.value : null,
  p50Latency: baselinePing.hasLatencyData.value ? baselinePing.p50Latency.value : null,
  p95Latency: baselinePing.hasLatencyData.value ? baselinePing.p95Latency.value : null,
  sampleCount: baselinePing.hasData.value ? baselinePing.sampleCount.value : 0,
  hasData: baselinePing.hasData.value,
  stale: baselinePing.stale.value,
  loading: baselinePing.loading.value,
  error: baselinePing.error.value,
}))
const adaptive = computed(() => calculateAdaptiveBaseline(
  currentPing.hasLatencyData.value && !currentPing.stale.value ? currentPing.avgLatency.value : null,
  baselineWindow.value,
))
const status = computed(() => {
  if (health.value === 'offline')
    return { label: '探测来源节点已离线', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
  if (health.value === 'error') {
    if (config.value.live && !sourceNode.value)
      return { label: '探测节点未找到', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
    if (ping.error.value)
      return { label: '实时任务读取失败', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
    if ((loss.value ?? 0) >= 20)
      return { label: '严重丢包', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
    if ((latency.value ?? 0) >= 1000)
      return { label: '延迟异常', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
    return { label: '异常', tone: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-400' }
  }
  if (ping.loading.value)
    return { label: '读取中', tone: 'text-slate-500 dark:text-slate-400', dot: 'bg-slate-500' }
  if (config.value.live && ping.stale.value)
    return { label: '数据已过期', tone: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' }
  if (!hasLiveData.value)
    return { label: config.value.live ? '等待任务数据' : '静态基线', tone: 'text-slate-500 dark:text-slate-400', dot: 'bg-slate-500' }
  if ((loss.value ?? 0) > 3 || ping.avgVolatility.value > 1.8)
    return { label: '存在波动', tone: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' }
  return { label: '实时稳定', tone: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-400' }
})

function sampleHeight(latency: number | null): number {
  if (latency === null)
    return 5
  return Math.round(Math.min(9, Math.max(5, 5 + latency / maximumLatency.value * 4)))
}

function formatAvailability(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(value >= 99.95 ? 2 : 1)}%`
}

function formatDeviation(value: number | null): string {
  if (value === null)
    return '-'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

const adaptiveTone = computed(() => {
  if (adaptive.value.tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (adaptive.value.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (adaptive.value.tone === 'healthy')
    return 'text-emerald-700 dark:text-emerald-300'
  return 'text-muted-foreground'
})

const sampleBars = computed<TelemetrySample[]>(() => history.value.map((point, index) => {
  const latencyText = point.latency === null ? '无响应' : formatTopologyLatency(point.latency)
  const lossText = `丢包 ${formatTopologyLoss(point.loss)}`
  const tone = resolveTopologySampleTone(point.latency, point.loss, baselineLatency.value)
  return {
    key: `${history.value.length - 1 - index}`,
    height: sampleHeight(point.latency),
    tone,
    toneClass: tone === 'critical' ? 'bg-rose-400 opacity-75' : tone === 'warning' ? 'bg-amber-400' : 'bg-emerald-400',
    valueText: latencyText,
    secondaryText: lossText,
    timeText: formatDateTime(point.time, props.hours === 1 ? 'HH:mm:ss' : 'MM-DD HH:mm'),
    ariaLabel: `${telemetryLabel.value}，${latencyText}，${lossText}，${formatDateTime(point.time)}`,
  }
}))
</script>

<template>
  <article class="rounded-xl border border-border/60 bg-background/35 p-3.5">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span class="truncate">{{ sourceLabel }}</span>
          <span class="text-muted-foreground">→</span>
          <span class="truncate">{{ targetLabel }}</span>
        </div>
        <div class="mt-1 text-[10px] text-muted-foreground" :title="telemetryLabel">
          {{ telemetryLabel }}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5 text-[10px]" :class="status.tone">
        <span class="size-1.5 rounded-full" :class="status.dot" />{{ status.label }}
      </div>
    </header>

    <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          平均延迟
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ latencyText }}
        </div>
      </div>
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          P95 延迟
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ hasLiveData ? (ping.hasLatencyData.value ? formatTopologyLatency(ping.p95Latency.value) : '无响应') : '-' }}
        </div>
      </div>
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          可用率
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ hasLiveData ? formatAvailability(ping.availability.value) : '-' }}
        </div>
        <div class="mt-0.5 text-[9px] text-muted-foreground">
          丢包 {{ formatTopologyLoss(loss) }}
        </div>
      </div>
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          相对 24h 基线
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums" :class="adaptiveTone">
          {{ formatDeviation(adaptive.deviationPercent) }}
        </div>
        <div class="mt-0.5 truncate text-[9px]" :class="adaptiveTone">
          {{ adaptive.label }}
        </div>
      </div>
    </div>

    <div class="mt-4">
      <div class="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>延迟走势</span>
        <span>{{ hours === 1 ? '最近 1 小时' : hours === 24 ? '最近 24 小时' : '最近 7 天' }}</span>
      </div>
      <div v-if="sampleBars.length" class="flex h-14 items-end rounded-lg bg-card/35 px-2 py-2">
        <TelemetrySampleStrip
          :samples="sampleBars"
          :label="telemetryLabel"
          kind="topology"
          variant="bars"
          class="h-full"
        />
      </div>
      <div v-else class="flex h-14 items-center justify-center rounded-lg border border-dashed border-border/60 text-[11px] text-muted-foreground">
        {{ ping.error.value ? '实时历史读取失败，当前显示备用基线' : '暂无匹配的实时历史数据' }}
      </div>
    </div>
  </article>
</template>
