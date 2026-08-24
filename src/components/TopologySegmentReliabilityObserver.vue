<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyReliabilityWindow, TopologySegmentReliabilitySnapshot } from '@/utils/topologyIntelligence'
import type { TopologyProbeMode } from '@/utils/topologyModel'
import { computed, watch } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { resolveTopologyMetricSource } from '@/utils/topologyHelper'
import { analyzeTopologyPeakInsight, bucketTopologyInsightsByBeijingHour, calculateTopologyInsightBaseline, detectTopologyBaselineShift, diagnoseTopologySegment, getTopologyInsightCoverage } from '@/utils/topologyInsights'
import { calculateAdaptiveBaseline } from '@/utils/topologyIntelligence'
import { parseTopologyMetric } from '@/utils/topologyLegacyFormat'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  current?: TopologySegmentTelemetry
  sourceUuid?: string
  probeMode?: TopologyProbeMode
}>()

const emit = defineEmits<{
  snapshotChange: [snapshot: TopologySegmentReliabilitySnapshot]
}>()

const config = computed(() => parseTopologyMetric(props.metric))
const probeMode = computed(() => props.probeMode ?? config.value.probeMode ?? (config.value.live ? 'live' : 'static'))
const sourceNode = computed(() => resolveTopologyMetricSource(props.nodes, config.value.nodeName, props.sourceUuid))
const enabled = computed(() => config.value.live && Boolean(sourceNode.value) && sourceNode.value?.online !== false)

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
    avgLatency: ping.hasLatencyData.value ? ping.avgLatency.value : null,
    p50Latency: ping.hasLatencyData.value ? ping.p50Latency.value : null,
    p95Latency: ping.hasLatencyData.value ? ping.p95Latency.value : null,
    sampleCount: ping.hasData.value ? ping.sampleCount.value : 0,
    hasData: ping.hasData.value,
    stale: ping.stale.value,
    loading: ping.loading.value,
    error: ping.error.value,
  }
}

const snapshot = computed<TopologySegmentReliabilitySnapshot>(() => {
  const day = reliabilityWindow(24, dayPing)
  const dayPoints = dayPing.insightPoints.value
  const weekPoints = weekPing.insightPoints.value
  const hourlyProfile = bucketTopologyInsightsByBeijingHour(weekPoints)
  const dayCoverage = getTopologyInsightCoverage(dayPoints, dayPing.stale.value)
  const weekCoverage = getTopologyInsightCoverage(weekPoints, weekPing.stale.value)
  const baseline = calculateTopologyInsightBaseline(dayPoints)
  return {
    day,
    week: reliabilityWindow(168, weekPing),
    adaptive: calculateAdaptiveBaseline(props.current?.latency ?? null, day),
    insights: {
      live: config.value.live,
      probeMode: probeMode.value,
      sourceUuid: sourceNode.value?.uuid ?? '',
      taskId: weekPing.selectedTaskId.value ?? dayPing.selectedTaskId.value,
      taskName: weekPing.selectedTaskName.value || dayPing.selectedTaskName.value || config.value.taskFilter,
      diagnosis: diagnoseTopologySegment({
        currentLatency: props.current?.latency ?? null,
        currentLoss: props.current?.loss ?? null,
        hasLiveData: props.current?.hasLiveData ?? false,
        stale: props.current?.stale ?? true,
        history: dayPoints,
      }),
      hourlyProfile,
      peakInsight: analyzeTopologyPeakInsight(hourlyProfile, {
        stale: weekPing.stale.value,
        taskId: weekPing.selectedTaskId.value,
      }),
      baselineShift: detectTopologyBaselineShift(weekPoints, { stale: weekPing.stale.value }),
      coverage: weekCoverage,
      evidence: {
        currentLatency: props.current?.hasLiveData ? props.current.latency : null,
        currentLoss: props.current?.hasLiveData ? props.current.loss : null,
        baselineLatencyP50: baseline.latencyP50,
        baselineLatencyP95: baseline.latencyP95,
        baselineLossMedian: baseline.lossMedian,
        baselineSampleCount: baseline.sampleCount,
        latestSampleAt: dayPing.lastFetchedAt.value || null,
        freshness: dayPing.freshness.value,
        dayCoverage,
        weekCoverage,
      },
    },
  }
})

watch(snapshot, value => emit('snapshotChange', value), { immediate: true })
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
