<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteHealth } from '@/utils/topologyHealth'
import { computed, watch } from 'vue'
import TopologyEdgeSamples from '@/components/TopologyEdgeSamples.vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatTopologyLatency, formatTopologyLoss, parseTopologyMetric } from '@/utils/topologyHelper'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  sourceLabel: string
  targetLabel: string
  segmentIndex: number
}>()
const emit = defineEmits<{
  openDetail: []
  statusChange: [status: TopologyRouteHealth]
}>()
const config = computed(() => parseTopologyMetric(props.metric))
const sourceNode = computed(() => props.nodes.find(node => node.name.trim().toLowerCase() === config.value.nodeName.toLowerCase()))
const ping = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 1,
    enabled: () => config.value.live && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
  },
)

const latency = computed(() => ping.hasData.value ? ping.avgLatency.value : config.value.fallbackLatency)
const loss = computed(() => ping.hasData.value ? ping.avgLoss.value : config.value.fallbackLoss)
const sourceState = computed(() => {
  if (!config.value.live)
    return { label: '静态基线', line: 'bg-slate-500/55' }
  if (!sourceNode.value)
    return { label: '探测节点未找到', line: 'bg-rose-400/55' }
  if (ping.loading.value)
    return { label: '正在读取实时任务', line: 'bg-amber-400/55' }
  if (ping.error.value)
    return { label: '实时任务读取失败', line: 'bg-rose-400/55' }
  if (!ping.hasData.value)
    return { label: '暂无匹配的实时数据，当前显示备用基线', line: 'bg-amber-400/55' }
  return { label: '实时 Ping 数据', line: 'bg-slate-600/70' }
})
const lossTone = computed(() => {
  if (loss.value === null || loss.value <= 1)
    return 'text-slate-300'
  if (loss.value <= 3)
    return 'text-amber-300'
  return 'text-rose-400'
})

const health = computed<TopologyRouteHealth>(() => {
  if (!config.value.live) {
    if (config.value.fallbackLatency === null && config.value.fallbackLoss === null)
      return 'pending'
    return (config.value.fallbackLoss ?? 0) > 3 ? 'warning' : 'healthy'
  }
  if (!sourceNode.value || ping.error.value)
    return 'error'
  if (ping.loading.value || !ping.hasData.value)
    return 'pending'
  return ping.avgLoss.value > 3 || ping.avgVolatility.value > 1.8 ? 'warning' : 'healthy'
})

watch(health, value => emit('statusChange', value), { immediate: true })

function median(values: number[]): number {
  if (!values.length)
    return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2)
    return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function sampleHeight(latency: number | null, baseline: number): number {
  if (latency === null)
    return 5
  if (baseline <= 0)
    return 7
  return Math.round(Math.min(9, Math.max(5, 7 + (latency / baseline - 1) * 6)))
}

const sampleBars = computed(() => {
  const points = ping.history.value.slice(-10)
  const validLatencies = points
    .map(point => point.latency)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const baseline = median(validLatencies)
  return points.map((point, index) => ({
    key: `${props.segmentIndex}-${point.time}-${index}`,
    height: sampleHeight(point.latency, baseline),
    alert: (point.loss !== null && point.loss > 3)
      || (point.latency !== null && baseline > 0 && point.latency > baseline * 1.18),
    unavailable: point.latency === null,
    latency: point.latency,
    loss: point.loss,
    time: point.time,
    segmentIndex: props.segmentIndex,
    segmentLabel: `${props.sourceLabel} → ${props.targetLabel}`,
  }))
})
</script>

<template>
  <div
    class="relative flex h-10 min-w-[190px] flex-1 items-center"
    :data-topology-edge-samples="sampleBars.length ? '' : undefined"
    :title="`${sourceState.label}${config.live ? ` · ${config.taskFilter || '未指定任务'}` : ''}`"
    :aria-label="`${sourceState.label}：${formatTopologyLatency(latency)}，丢包 ${formatTopologyLoss(loss)}`"
  >
    <TopologyEdgeSamples :bars="sampleBars" :line-class="sourceState.line" />
    <button
      type="button"
      data-topology-current-metric
      class="absolute left-1/2 top-0 z-2 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] font-medium tabular-nums text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60 sm:text-[11px]"
      aria-label="查看线路历史"
      @click="emit('openDetail')"
    >
      {{ formatTopologyLatency(latency) }}
      <span class="mx-0.5 text-slate-600">/</span>
      <span :class="lossTone">{{ formatTopologyLoss(loss) }}</span>
    </button>
  </div>
</template>
