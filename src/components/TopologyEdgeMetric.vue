<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TelemetrySample } from '@/types/telemetry'
import type { TopologyRouteHealth, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import { computed, watch } from 'vue'
import TopologyEdgeSamples from '@/components/TopologyEdgeSamples.vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatDateTime } from '@/utils/helper'
import { resolveTopologySegmentHealth } from '@/utils/topologyHealth'
import { calculateTopologyLatencyBaseline, formatTopologyLatency, formatTopologyLoss, formatTopologyTelemetryLabel, parseTopologyMetric, resolveTopologySampleTone } from '@/utils/topologyHelper'
import { resolveTopologyNodeIdentity } from '@/utils/topologyNodeIdentity'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  sourceLabel: string
  targetLabel: string
  segmentIndex: number
  mobile?: boolean
  observeOnly?: boolean
}>()
const emit = defineEmits<{
  openDetail: []
  statusChange: [status: TopologyRouteHealth]
  metricsChange: [metrics: TopologySegmentTelemetry]
}>()
const config = computed(() => parseTopologyMetric(props.metric))
const telemetryLabel = computed(() => formatTopologyTelemetryLabel(props.metric, props.sourceLabel, props.targetLabel))
const sourceNode = computed(() => resolveTopologyNodeIdentity(props.nodes, config.value.nodeName))
const ping = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 1,
    enabled: () => config.value.live && sourceNode.value?.online !== false && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const latency = computed(() => ping.hasData.value && !ping.stale.value
  ? (ping.hasLatencyData.value ? ping.avgLatency.value : null)
  : config.value.fallbackLatency)
const loss = computed(() => ping.hasData.value && !ping.stale.value ? ping.avgLoss.value : config.value.fallbackLoss)
const latencyText = computed(() => config.value.live && ping.hasData.value && !ping.stale.value && !ping.hasLatencyData.value
  ? '无响应'
  : formatTopologyLatency(latency.value))
const sourceState = computed(() => {
  if (!config.value.live)
    return { label: '静态基线', line: 'bg-slate-400/70 dark:bg-slate-500/55' }
  if (!sourceNode.value)
    return { label: '探测节点未找到', line: 'bg-rose-400/55' }
  if (!sourceNode.value.online)
    return { label: '探测来源节点已离线', line: 'bg-rose-400/55' }
  if (ping.loading.value)
    return { label: '正在读取实时任务', line: 'bg-amber-400/55' }
  if (ping.error.value)
    return { label: '实时任务读取失败', line: 'bg-rose-400/55' }
  if (ping.stale.value)
    return { label: '实时数据已过期，当前显示备用基线', line: 'bg-amber-400/55' }
  if (!ping.hasData.value)
    return { label: '暂无匹配的实时数据，当前显示备用基线', line: 'bg-amber-400/55' }
  // 有采样但一次都没成功：探测确实打不通，不是没数据，两者要能分辨。
  if (!ping.hasLatencyData.value)
    return { label: '探测任务没有任何成功响应', line: 'bg-rose-400/55' }
  return { label: '实时 Ping 数据', line: 'bg-slate-400/70 dark:bg-slate-600/70' }
})
const lossTone = computed(() => {
  if (loss.value === null || loss.value <= 1)
    return 'text-slate-600 dark:text-slate-300'
  if (loss.value <= 3)
    return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-600 dark:text-rose-400'
})

const health = computed<TopologyRouteHealth>(() => {
  return resolveTopologySegmentHealth({
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
  })
})

watch(health, value => emit('statusChange', value), { immediate: true })

const telemetry = computed<TopologySegmentTelemetry>(() => ({
  status: health.value,
  latency: latency.value,
  loss: loss.value,
  volatility: ping.hasData.value && !ping.stale.value ? ping.avgVolatility.value : null,
  hasLiveData: config.value.live && ping.hasData.value && !ping.stale.value,
  stale: ping.stale.value,
}))

watch(telemetry, value => emit('metricsChange', value), { immediate: true })

function sampleHeight(latency: number | null, baseline: number | null): number {
  if (latency === null)
    return 5
  if (baseline === null || baseline <= 0)
    return 7
  return Math.round(Math.min(9, Math.max(5, 7 + (latency / baseline - 1) * 6)))
}

const sampleBars = computed<TelemetrySample[]>(() => {
  const points = ping.history.value.slice(-10)
  const baseline = calculateTopologyLatencyBaseline(points.map(point => point.latency))
  return points.map((point, index) => {
    const tone = resolveTopologySampleTone(point.latency, point.loss, baseline)
    const latencyText = point.latency === null ? '无响应' : formatTopologyLatency(point.latency)
    const lossText = `丢包 ${formatTopologyLoss(point.loss)}`
    return {
      key: `${props.segmentIndex}-${point.time}-${index}`,
      height: sampleHeight(point.latency, baseline),
      tone,
      toneClass: tone === 'critical' ? 'bg-rose-400 opacity-75' : tone === 'warning' ? 'bg-amber-400' : 'bg-emerald-400',
      valueText: latencyText,
      secondaryText: lossText,
      timeText: formatDateTime(point.time, 'HH:mm:ss'),
      ariaLabel: `${telemetryLabel.value}，${latencyText}，${lossText}，${formatDateTime(point.time)}`,
    }
  })
})
</script>

<template>
  <div
    v-if="!observeOnly"
    class="relative flex h-10 flex-1 items-center"
    :class="mobile ? 'min-w-0' : 'min-w-[190px]'"
    :data-topology-edge-samples="sampleBars.length ? '' : undefined"
    :title="`${sourceState.label}${config.live ? ` · ${config.taskFilter || '未指定任务'}` : ''}`"
    :aria-label="`${sourceState.label}：${latencyText}，丢包 ${formatTopologyLoss(loss)}`"
  >
    <TopologyEdgeSamples
      :bars="sampleBars"
      :line-class="sourceState.line"
      :label="telemetryLabel"
    />
    <button
      type="button"
      data-topology-current-metric
      class="absolute left-1/2 top-0 z-2 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] font-medium tabular-nums text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 dark:text-slate-400 dark:hover:text-slate-100 dark:focus-visible:ring-emerald-400/60 sm:text-[11px]"
      :aria-label="`${telemetryLabel}，线路状态：${sourceState.label}，${latencyText}，丢包 ${formatTopologyLoss(loss)}，查看线路历史`"
      @click="emit('openDetail')"
    >
      {{ latencyText }}
      <span class="mx-0.5 text-slate-400 dark:text-slate-600">/</span>
      <span :class="lossTone">{{ formatTopologyLoss(loss) }}</span>
    </button>
  </div>
  <span v-else data-topology-telemetry-observer class="hidden" aria-hidden="true" />
</template>
