<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyReliabilityWindow, TopologySegmentReliabilitySnapshot } from '@/utils/topologyIntelligence'
import { computed, watch } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { findUniqueTopologyNode, parseTopologyMetric } from '@/utils/topologyHelper'
import { calculateAdaptiveBaseline } from '@/utils/topologyIntelligence'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  current?: TopologySegmentTelemetry
}>()

const emit = defineEmits<{
  snapshotChange: [snapshot: TopologySegmentReliabilitySnapshot]
}>()

const config = computed(() => parseTopologyMetric(props.metric))
const sourceNode = computed(() => findUniqueTopologyNode(props.nodes, config.value.nodeName))
const enabled = computed(() => config.value.live && Boolean(sourceNode.value))

const dayPing = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 24,
    maxCount: 240,
    enabled,
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

const weekPing = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: 168,
    maxCount: 240,
    enabled,
    taskNameFilter: () => config.value.taskFilter,
    taskNameMatch: 'exact',
  },
)

function reliabilityWindow(hours: 24 | 168, ping: typeof dayPing): TopologyReliabilityWindow {
  return {
    hours,
    availability: ping.hasData.value ? ping.availability.value : null,
    avgLatency: ping.hasData.value ? ping.avgLatency.value : null,
    p50Latency: ping.hasData.value ? ping.p50Latency.value : null,
    p95Latency: ping.hasData.value ? ping.p95Latency.value : null,
    sampleCount: ping.hasData.value ? ping.sampleCount.value : 0,
    hasData: ping.hasData.value,
    stale: ping.stale.value,
    loading: ping.loading.value,
    error: ping.error.value,
  }
}

const snapshot = computed<TopologySegmentReliabilitySnapshot>(() => {
  const day = reliabilityWindow(24, dayPing)
  return {
    day,
    week: reliabilityWindow(168, weekPing),
    adaptive: calculateAdaptiveBaseline(props.current?.latency ?? null, day),
  }
})

watch(snapshot, value => emit('snapshotChange', value), { immediate: true })
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
