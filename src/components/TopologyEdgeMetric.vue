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
const lossTone = computed(() => {
  if (loss.value === null || loss.value <= 1)
    return 'text-slate-300'
  if (loss.value <= 3)
    return 'text-amber-300'
  return 'text-rose-400'
})
</script>

<template>
  <div class="flex min-w-[118px] flex-1 items-center gap-2" :title="config.live ? `实时任务：${config.taskFilter || '全部 Ping'}` : '实测基线'">
    <span class="h-px min-w-2 flex-1 bg-emerald-400/75" />
    <span class="shrink-0 whitespace-nowrap text-[10px] font-medium tabular-nums text-slate-300 sm:text-[11px]">
      {{ formatTopologyLatency(latency) }}
      <span class="mx-0.5 text-slate-600">/</span>
      <span :class="lossTone">{{ formatTopologyLoss(loss) }}</span>
    </span>
    <span class="h-px min-w-2 flex-1 bg-emerald-400/75" />
  </div>
</template>
