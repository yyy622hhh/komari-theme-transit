<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { parseTopologyMetric } from '@/utils/topologyHelper'

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

const bars = computed(() => {
  const points = ping.history.value.slice(-12)
  if (!points.length)
    return []

  const latencies = points.map(point => point.latency ?? 0)
  const maximum = Math.max(...latencies, 1)
  return points.map((point, index) => ({
    key: `${point.time}-${index}`,
    height: point.latency === null ? 16 : Math.max(18, point.latency / maximum * 100),
    alert: point.loss !== null && point.loss > 3,
  }))
})

const stable = computed(() => {
  if (!ping.hasData.value)
    return config.value.fallbackLoss === null || config.value.fallbackLoss <= 3
  return ping.avgLoss.value <= 3 && ping.avgVolatility.value <= 30
})

const statusLabel = computed(() => {
  if (!ping.hasData.value)
    return stable.value ? '基线' : '异常'
  return stable.value ? '稳定' : '波动'
})
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2.5">
    <div v-if="bars.length" class="hidden h-4 w-20 items-end gap-[2px] sm:flex" aria-hidden="true">
      <span
        v-for="bar in bars"
        :key="bar.key"
        class="min-w-0 flex-1 rounded-[1px] bg-emerald-400/70"
        :class="bar.alert ? '!bg-amber-400/80' : ''"
        :style="{ height: `${bar.height}%` }"
      />
    </div>
    <span class="text-[10px]" :class="stable ? 'text-slate-400' : 'text-amber-300'">
      {{ statusLabel }}
    </span>
  </div>
</template>
