<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatTopologyLatency, formatTopologyLoss, parseTopologyMetric } from '@/utils/topologyHelper'

const props = defineProps<{ metric: string, nodes: NodeData[] }>()
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
    return { label: '静态基线', dot: 'bg-slate-500', line: 'bg-slate-500/55' }
  if (!sourceNode.value)
    return { label: '探测节点未找到', dot: 'bg-rose-400', line: 'bg-rose-400/55' }
  if (ping.loading.value)
    return { label: '正在读取实时任务', dot: 'bg-amber-400 animate-pulse', line: 'bg-amber-400/55' }
  if (ping.error.value)
    return { label: '实时任务读取失败', dot: 'bg-rose-400', line: 'bg-rose-400/55' }
  if (!ping.hasData.value)
    return { label: '暂无匹配的实时数据，当前显示备用基线', dot: 'bg-amber-400', line: 'bg-amber-400/55' }
  return { label: '实时 Ping 数据', dot: 'bg-emerald-400', line: 'bg-emerald-400/75' }
})
const lossTone = computed(() => {
  if (loss.value === null || loss.value <= 1)
    return 'text-slate-300'
  if (loss.value <= 3)
    return 'text-amber-300'
  return 'text-rose-400'
})
</script>

<template>
  <div
    class="flex min-w-[118px] flex-1 items-center justify-center gap-2"
    :title="`${sourceState.label}${config.live ? ` · ${config.taskFilter || '未指定任务'}` : ''}`"
    :aria-label="`${sourceState.label}：${formatTopologyLatency(latency)}，丢包 ${formatTopologyLoss(loss)}`"
  >
    <span data-topology-edge-line class="h-px min-w-2 max-w-16 flex-1" :class="sourceState.line" />
    <span class="shrink-0 whitespace-nowrap text-[10px] font-medium tabular-nums text-slate-300 sm:text-[11px]">
      <i class="mr-1 inline-block size-1.5 rounded-full align-middle" :class="sourceState.dot" />
      {{ formatTopologyLatency(latency) }}
      <span class="mx-0.5 text-slate-600">/</span>
      <span :class="lossTone">{{ formatTopologyLoss(loss) }}</span>
    </span>
    <span data-topology-edge-line class="h-px min-w-2 max-w-16 flex-1" :class="sourceState.line" />
  </div>
</template>
