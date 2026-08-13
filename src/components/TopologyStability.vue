<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed, watch } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { parseTopologyMetric } from '@/utils/topologyHelper'

export type TopologyRouteHealth = 'healthy' | 'warning' | 'pending' | 'error' | 'offline'

const props = defineProps<{ metrics: string[], nodeNames: string[], nodes: NodeData[] }>()
const emit = defineEmits<{ statusChange: [status: TopologyRouteHealth] }>()
const configs = [
  computed(() => parseTopologyMetric(props.metrics[0] || '-,-')),
  computed(() => parseTopologyMetric(props.metrics[1] || '-,-')),
]
const sourceNodes = configs.map(config => computed(() => props.nodes.find(node => node.name.trim().toLowerCase() === config.value.nodeName.toLowerCase())))
const firstPing = useNodePingStats(
  () => sourceNodes[0]!.value?.uuid ?? '',
  {
    hours: 1,
    enabled: () => configs[0]!.value.live && Boolean(sourceNodes[0]!.value),
    taskNameFilter: () => configs[0]!.value.taskFilter,
  },
)
const secondPing = useNodePingStats(
  () => sourceNodes[1]!.value?.uuid ?? '',
  {
    hours: 1,
    enabled: () => configs[1]!.value.live && Boolean(sourceNodes[1]!.value),
    taskNameFilter: () => configs[1]!.value.taskFilter,
  },
)
const pings = [firstPing, secondPing]

const configuredNodes = computed(() => props.nodeNames.slice(1).map(name => props.nodes.find(node => node.name.trim().toLowerCase() === name.trim().toLowerCase())))

function segmentHealth(index: number): TopologyRouteHealth {
  const config = configs[index]!.value
  const ping = pings[index]!
  if (!config.live) {
    if (config.fallbackLatency === null && config.fallbackLoss === null)
      return 'pending'
    return (config.fallbackLoss ?? 0) > 3 ? 'warning' : 'healthy'
  }
  if (!sourceNodes[index]!.value || ping.error.value)
    return 'error'
  if (ping.loading.value || !ping.hasData.value)
    return 'pending'
  return ping.avgLoss.value > 3 || ping.avgVolatility.value > 1.8 ? 'warning' : 'healthy'
}

const health = computed<TopologyRouteHealth>(() => {
  if (configuredNodes.value.some(node => node?.online === false))
    return 'offline'
  if (configuredNodes.value.some(node => !node))
    return 'error'

  const states = configs.slice(0, Math.max(1, props.nodeNames.length - 1)).map((_, index) => segmentHealth(index))
  for (const status of ['offline', 'error', 'warning', 'pending'] as const) {
    if (states.includes(status))
      return status
  }
  return 'healthy'
})

watch(health, value => emit('statusChange', value), { immediate: true })

const bars = computed(() => {
  const points = pings.flatMap(ping => ping.history.value.slice(-6)).slice(-12)
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

const statusMeta = computed(() => {
  const values = {
    healthy: { label: configs.every(config => !config.value.live) ? '基线' : '稳定', tone: 'text-slate-400' },
    warning: { label: '波动', tone: 'text-amber-300' },
    pending: { label: '待数据', tone: 'text-amber-300' },
    error: { label: '异常', tone: 'text-rose-400' },
    offline: { label: '失联', tone: 'text-rose-400' },
  } as const
  return values[health.value]
})
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2">
    <div v-if="bars.length" class="hidden h-4 min-w-0 flex-1 items-end gap-[2px] sm:flex" aria-hidden="true">
      <span
        v-for="bar in bars"
        :key="bar.key"
        class="min-w-0 flex-1 rounded-[1px] bg-emerald-400/70"
        :class="bar.alert ? '!bg-amber-400/80' : ''"
        :style="{ height: `${bar.height}%` }"
      />
    </div>
    <span data-topology-status class="shrink-0 whitespace-nowrap text-[10px]" :class="statusMeta.tone">
      {{ statusMeta.label }}
    </span>
  </div>
</template>
