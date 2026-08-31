<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TelemetrySample } from '@/types/telemetry'
import type { TopologyRouteHealth, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyProbeMode } from '@/utils/topologyModel'
import { computed, watch } from 'vue'
import TopologyEdgeSamples from '@/components/TopologyEdgeSamples.vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatDateTime } from '@/utils/helper'
import { formatProbeCurrentLabel, probeCurrentTone, probeFailureRateLabel } from '@/utils/pingCurrentState'
import { resolveTopologySegmentHealth } from '@/utils/topologyHealth'
import { calculateTopologyLatencyBaseline, formatTopologyLatency, formatTopologyLoss, resolveTopologyMetricSource, resolveTopologySampleTone } from '@/utils/topologyHelper'
import { formatTopologyTelemetryLabel, parseTopologyMetric } from '@/utils/topologyLegacyFormat'
import { topologyProbeDirection } from '@/utils/topologyProbeDirection'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  sourceLabel: string
  targetLabel: string
  segmentIndex: number
  sourceUuid?: string
  probeMode?: TopologyProbeMode
  mobile?: boolean
  observeOnly?: boolean
}>()
const emit = defineEmits<{
  openDetail: []
  statusChange: [status: TopologyRouteHealth]
  metricsChange: [metrics: TopologySegmentTelemetry]
}>()
const config = computed(() => parseTopologyMetric(props.metric))
const probeMode = computed(() => props.probeMode ?? config.value.probeMode ?? (config.value.live ? 'live' : 'static'))
const telemetryLabel = computed(() => formatTopologyTelemetryLabel(props.metric, props.sourceLabel, props.targetLabel))
const sourceNode = computed(() => resolveTopologyMetricSource(props.nodes, config.value.nodeName, props.sourceUuid))
const direction = computed(() => topologyProbeDirection(props.segmentIndex, config.value.live, sourceNode.value?.uuid, props.sourceUuid))
const ping = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 1,
    enabled: () => config.value.live && sourceNode.value?.online !== false && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const hasLiveData = computed(() => config.value.live && ping.hasData.value && !ping.stale.value)
const metricSourceLabel = computed(() => hasLiveData.value ? '近 1 小时平均' : config.value.live ? '备用配置基线' : '配置基线')
const latency = computed(() => hasLiveData.value
  ? (ping.hasLatencyData.value ? ping.avgLatency.value : null)
  : config.value.fallbackLatency)
const currentStatus = computed(() => sourceNode.value?.online === false ? 'offline' : ping.current.value.status)
const currentLabel = computed(() => probeMode.value === 'auto' ? '等待探测' : !config.value.live ? '静态基线' : formatProbeCurrentLabel(currentStatus.value, ping.avgLoss.value > 0))
const sampleUpdateLabel = computed(() => !config.value.live
  ? '配置值，不代表近期采样'
  : ping.current.value.latestAt ? `样本更新 ${formatDateTime(new Date(ping.current.value.latestAt), 'HH:mm:ss')}` : '无近期原始样本')
const failureLabel = computed(() => probeFailureRateLabel(ping.probeType.value))
const loss = computed(() => hasLiveData.value ? ping.avgLoss.value : config.value.fallbackLoss)
const latencyText = computed(() => hasLiveData.value && !ping.hasLatencyData.value
  ? '无响应'
  : formatTopologyLatency(latency.value))
const sourceState = computed(() => {
  if (probeMode.value === 'auto')
    return { label: '等待自动创建探测任务', line: 'bg-amber-400/55' }
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
  if (ping.delayed.value)
    return { label: '实时数据可能不是最新，继续显示最后数据', line: 'bg-amber-400/55' }
  if (!ping.hasData.value)
    return { label: '暂无匹配的实时数据，当前显示备用基线', line: 'bg-amber-400/55' }
  // 这里描述历史窗口；当前连通性只能由原始样本单独判断。
  if (!ping.hasLatencyData.value)
    return { label: '近 1 小时没有成功响应', line: 'bg-rose-400/55' }
  return { label: '实时 Ping 数据', line: 'bg-slate-400/70 dark:bg-slate-600/70' }
})
const health = computed<TopologyRouteHealth>(() => {
  return resolveTopologySegmentHealth({
    live: config.value.live,
    probeMode: probeMode.value,
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
  hasLiveData: hasLiveData.value,
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
    const lossText = `${failureLabel.value} ${formatTopologyLoss(point.loss)}`
    return {
      key: `${props.segmentIndex}-${points.length - 1 - index}`,
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
    class="topology-edge relative flex min-w-0 flex-1 flex-col gap-2 py-2 text-center"
    :class="mobile ? 'min-w-0' : 'min-w-[120px]'"
    :data-topology-edge-samples="sampleBars.length ? '' : undefined"
    :title="`${sourceState.label}${config.live ? ` · ${config.taskFilter || '未指定任务'}` : ''}`"
    :aria-label="`${sourceState.label}，当前：${currentLabel}，${metricSourceLabel}：${latencyText}，${failureLabel} ${formatTopologyLoss(loss)}`"
  >
    <span
      :data-topology-current="config.live ? currentStatus : 'static'"
      class="min-w-0 break-words text-xs font-medium leading-4"
      :class="config.live ? probeCurrentTone(currentStatus) : 'text-slate-600 dark:text-slate-300'"
      :title="`当前：${currentLabel}；样本更新：${ping.current.value.latestAt ? formatDateTime(new Date(ping.current.value.latestAt)) : '未知'}；最近成功：${ping.current.value.lastSuccessAt ? formatDateTime(new Date(ping.current.value.lastSuccessAt)) : '窗口内无成功'}`"
    >{{ currentLabel }}</span>
    <TopologyEdgeSamples
      :bars="sampleBars"
      :line-class="sourceState.line"
      :label="telemetryLabel"
      :direction="direction"
      :vertical="mobile"
    />
    <button
      type="button"
      data-topology-current-metric
      :data-topology-history-source="hasLiveData ? 'history' : config.live ? 'fallback' : 'configured'"
      class="flex min-w-0 flex-col items-center justify-center gap-1 rounded px-1 text-xs leading-4 tabular-nums text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
      :title="`${sampleUpdateLabel}；${failureLabel} ${formatTopologyLoss(loss)}`"
      :aria-label="`${telemetryLabel}，当前：${currentLabel}，${metricSourceLabel} ${latencyText}，${failureLabel} ${formatTopologyLoss(loss)}，查看线路历史`"
      @click="emit('openDetail')"
    >
      <span class="order-2 text-[11px]">
        <span v-if="hasLiveData">近 1 小时均值</span>
        <span v-else-if="config.live">备用基线</span>
        <span v-else data-topology-probe-mode-label :data-probe-mode="probeMode">{{ probeMode === 'auto' ? '待探测' : '静态' }}</span>
      </span>
      <span class="min-w-0 break-words"><strong class="text-lg font-semibold text-foreground">{{ latencyText }}</strong><span v-if="hasLiveData && ping.probeType.value" class="ml-2 text-[10px]">{{ ping.probeType.value.toUpperCase() }}</span></span>
    </button>
  </div>
  <span v-else data-topology-telemetry-observer class="hidden" aria-hidden="true" />
</template>
