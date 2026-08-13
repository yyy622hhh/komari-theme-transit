<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { formatTopologyLatency, formatTopologyLoss, parseTopologyMetric } from '@/utils/topologyHelper'

const props = defineProps<{
  metric: string
  nodes: NodeData[]
  sourceLabel: string
  targetLabel: string
  hours: number
}>()

const config = computed(() => parseTopologyMetric(props.metric))
const sourceNode = computed(() => props.nodes.find(node => node.name.trim().toLowerCase() === config.value.nodeName.toLowerCase()))
const ping = useNodePingStats(
  () => sourceNode.value?.uuid ?? '',
  {
    hours: () => props.hours,
    maxCount: 240,
    enabled: () => config.value.live && Boolean(sourceNode.value),
    taskNameFilter: () => config.value.taskFilter,
  },
)

const latency = computed(() => ping.hasData.value ? ping.avgLatency.value : config.value.fallbackLatency)
const loss = computed(() => ping.hasData.value ? ping.avgLoss.value : config.value.fallbackLoss)
const history = computed(() => ping.history.value.slice(-20))
const maximumLatency = computed(() => Math.max(...history.value.map(point => point.latency ?? 0), 1))
const hasLiveData = computed(() => config.value.live && ping.hasData.value)
const status = computed(() => {
  if (ping.loading.value)
    return { label: '读取中', tone: 'text-slate-400', dot: 'bg-slate-500' }
  if (!hasLiveData.value)
    return { label: config.value.live ? '等待任务数据' : '静态基线', tone: 'text-slate-400', dot: 'bg-slate-500' }
  if ((loss.value ?? 0) > 3 || ping.avgVolatility.value > 1.8)
    return { label: '存在波动', tone: 'text-amber-300', dot: 'bg-amber-400' }
  return { label: '实时稳定', tone: 'text-emerald-300', dot: 'bg-emerald-400' }
})

function pointHeight(latency: number | null): string {
  if (latency === null)
    return '12%'
  return `${Math.max(16, latency / maximumLatency.value * 100)}%`
}
</script>

<template>
  <article class="rounded-xl border border-border/60 bg-background/35 p-3.5">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span class="truncate">{{ sourceLabel }}</span>
          <span class="text-muted-foreground">→</span>
          <span class="truncate">{{ targetLabel }}</span>
        </div>
        <div class="mt-1 truncate text-[10px] text-muted-foreground">
          {{ config.live ? `Ping 任务 · ${config.taskFilter || '未指定'}` : '手动录入的实测基线' }}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5 text-[10px]" :class="status.tone">
        <span class="size-1.5 rounded-full" :class="status.dot" />{{ status.label }}
      </div>
    </header>

    <div class="mt-4 grid grid-cols-3 gap-2">
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          平均延迟
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ formatTopologyLatency(latency) }}
        </div>
      </div>
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          平均丢包
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ formatTopologyLoss(loss) }}
        </div>
      </div>
      <div class="rounded-lg bg-card/55 px-2.5 py-2">
        <div class="text-[10px] text-muted-foreground">
          波动系数
        </div>
        <div class="mt-1 text-base font-semibold tabular-nums">
          {{ hasLiveData ? ping.avgVolatility.value.toFixed(2) : '-' }}
        </div>
      </div>
    </div>

    <div class="mt-4">
      <div class="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>延迟走势</span>
        <span>{{ hours === 1 ? '最近 1 小时' : hours === 24 ? '最近 24 小时' : '最近 7 天' }}</span>
      </div>
      <div v-if="history.length" class="flex h-14 items-end gap-1 rounded-lg bg-card/35 px-2 py-2" aria-label="延迟历史柱状图">
        <span
          v-for="(point, index) in history"
          :key="`${point.time}-${index}`"
          class="min-w-0 flex-1 rounded-[2px] bg-emerald-400/65"
          :class="point.loss !== null && point.loss > 3 ? '!bg-amber-400/80' : ''"
          :style="{ height: pointHeight(point.latency) }"
          :title="`${new Date(point.time).toLocaleString()} · ${formatTopologyLatency(point.latency)} / ${formatTopologyLoss(point.loss)}`"
        />
      </div>
      <div v-else class="flex h-14 items-center justify-center rounded-lg border border-dashed border-border/60 text-[11px] text-muted-foreground">
        {{ ping.error.value ? '实时历史读取失败，当前显示备用基线' : '暂无匹配的实时历史数据' }}
      </div>
    </div>
  </article>
</template>
