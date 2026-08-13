<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatDateTime } from '@/utils/helper'
import { parseTopologyMetric } from '@/utils/topologyHelper'

export type TopologyRouteHealth = 'healthy' | 'warning' | 'pending' | 'error' | 'offline'

const props = defineProps<{ metrics: string[], nodeNames: string[], nodes: NodeData[] }>()
const emit = defineEmits<{ statusChange: [status: TopologyRouteHealth] }>()
const isTouchTooltipMode = ref(false)
const activeSampleKey = ref<string | null>(null)
let coarsePointerMediaQuery: MediaQueryList | null = null
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

function median(values: number[]): number {
  if (!values.length)
    return 0

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2)
    return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function stabilityHeight(latency: number | null, baseline: number): number {
  if (latency === null)
    return 48
  if (baseline <= 0)
    return 76

  const relativeToBaseline = latency / baseline
  return Math.round(Math.min(96, Math.max(58, 76 + (relativeToBaseline - 1) * 70)))
}

const barGroups = computed(() => pings.map((ping, segmentIndex) => {
  const points = ping.history.value.slice(-6)
  const validLatencies = points
    .map(point => point.latency)
    .filter((latency): latency is number => latency !== null && Number.isFinite(latency))
  const baseline = median(validLatencies)
  const sourceName = props.nodeNames[segmentIndex] || `节点 ${segmentIndex + 1}`
  const targetName = props.nodeNames[segmentIndex + 1] || `节点 ${segmentIndex + 2}`

  return {
    segmentIndex,
    bars: points.map((point, index) => ({
      key: `${segmentIndex}-${point.time}-${index}`,
      height: stabilityHeight(point.latency, baseline),
      alert: point.loss !== null && point.loss > 3,
      unavailable: point.latency === null,
      latency: point.latency,
      loss: point.loss,
      time: point.time,
      segmentIndex,
      segmentLabel: `${sourceName} → ${targetName}`,
    })),
  }
}).filter(group => group.bars.length))

function formatLatency(value: number | null): string {
  return value === null ? '无响应' : `${Math.round(value)} ms`
}

function formatLoss(value: number | null): string {
  if (value === null)
    return '-'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function syncTouchTooltipMode(): void {
  if (typeof window === 'undefined') {
    isTouchTooltipMode.value = false
    return
  }

  isTouchTooltipMode.value = window.matchMedia('(hover: none), (pointer: coarse)').matches
  if (!isTouchTooltipMode.value)
    activeSampleKey.value = null
}

function setSampleTooltipOpen(key: string, open: boolean): void {
  if (!isTouchTooltipMode.value)
    return
  activeSampleKey.value = open ? key : activeSampleKey.value === key ? null : activeSampleKey.value
}

function toggleSampleTooltip(key: string): void {
  if (!isTouchTooltipMode.value)
    return
  activeSampleKey.value = activeSampleKey.value === key ? null : key
}

onMounted(() => {
  syncTouchTooltipMode()
  coarsePointerMediaQuery = window.matchMedia('(hover: none), (pointer: coarse)')
  coarsePointerMediaQuery.addEventListener('change', syncTouchTooltipMode)
})

onBeforeUnmount(() => {
  coarsePointerMediaQuery?.removeEventListener('change', syncTouchTooltipMode)
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
    <TooltipProvider v-if="barGroups.length" :delay-duration="0" :skip-delay-duration="0">
      <div class="hidden h-4 min-w-0 flex-1 items-end gap-1 sm:flex" aria-label="分段线路稳定度">
        <div
          v-for="group in barGroups"
          :key="group.segmentIndex"
          data-topology-segment-group
          :data-topology-segment="group.segmentIndex + 1"
          class="flex h-full min-w-0 flex-1 items-end gap-[2px] border-l border-white/[0.08] pl-1 first:border-l-0 first:pl-0"
        >
          <TooltipRoot
            v-for="bar in group.bars"
            :key="bar.key"
            :open="isTouchTooltipMode ? activeSampleKey === bar.key : undefined"
            @update:open="(open) => setSampleTooltipOpen(bar.key, open)"
          >
            <TooltipTrigger as-child>
              <button
                type="button"
                data-topology-sample
                :data-topology-sample-height="bar.height"
                class="group/sample flex h-full min-w-[3px] flex-1 cursor-default items-end justify-center rounded-[2px] focus-visible:outline-none"
                :aria-label="`${bar.segmentLabel}，${formatLatency(bar.latency)}，丢包 ${formatLoss(bar.loss)}，${formatDateTime(bar.time)}`"
                @click.stop="toggleSampleTooltip(bar.key)"
              >
                <span
                  class="block w-full max-w-[3px] rounded-full bg-emerald-400/70 transition-[filter,opacity] group-hover/sample:brightness-125 group-focus-visible/sample:ring-1 group-focus-visible/sample:ring-white/80"
                  :class="bar.unavailable ? '!bg-rose-400/80 opacity-70' : bar.alert ? '!bg-amber-400/80' : ''"
                  :style="{ height: `${bar.height}%` }"
                />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                data-topology-sample-detail
                side="top"
                :side-offset="7"
                class="z-50 w-52 rounded-lg border border-white/10 bg-[#101820]/95 px-3 py-2.5 text-slate-100 shadow-xl backdrop-blur-xl data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95"
              >
                <div class="min-w-0">
                  <div class="mb-2 flex min-w-0 items-center justify-between gap-3 border-b border-white/8 pb-2">
                    <span class="min-w-0 truncate text-[11px] font-semibold">第 {{ bar.segmentIndex + 1 }} 段</span>
                    <span class="shrink-0 text-[12px] font-semibold tabular-nums" :class="bar.unavailable ? 'text-rose-300' : bar.alert ? 'text-amber-300' : 'text-emerald-300'">
                      {{ formatLatency(bar.latency) }}
                    </span>
                  </div>
                  <p class="mb-2 truncate text-[10px] text-slate-400" :title="bar.segmentLabel">
                    {{ bar.segmentLabel }}
                  </p>
                  <dl class="grid grid-cols-[36px_1fr] gap-x-3 gap-y-1 text-[10px]">
                    <dt class="text-slate-500">
                      丢包
                    </dt>
                    <dd class="text-right font-medium tabular-nums" :class="bar.alert ? 'text-amber-300' : 'text-slate-200'">
                      {{ formatLoss(bar.loss) }}
                    </dd>
                    <dt class="text-slate-500">
                      时间
                    </dt>
                    <dd class="text-right font-medium tabular-nums text-slate-300">
                      {{ formatDateTime(bar.time, 'MM-DD HH:mm:ss') }}
                    </dd>
                  </dl>
                </div>
                <TooltipArrow class="size-2.5 rotate-45 rounded-[2px] bg-[#101820]/95 fill-[#101820]" />
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </div>
      </div>
    </TooltipProvider>
    <span data-topology-status class="shrink-0 whitespace-nowrap text-[10px]" :class="statusMeta.tone">
      {{ statusMeta.label }}
    </span>
  </div>
</template>
