<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteScore } from '@/utils/topologyHealth'
import type { TopologyRouteRanking, TopologyRouteReliability } from '@/utils/topologyIntelligence'
import { computed, ref } from 'vue'
import TopologySegmentHistory from '@/components/TopologySegmentHistory.vue'
import { AppDialog } from '@/components/ui/app-dialog'

export interface TopologyRouteDetail {
  key: string
  nodeNames: string[]
  metrics: string[]
  score: TopologyRouteScore
  reliability: TopologyRouteReliability
  ranking?: TopologyRouteRanking
  directionLabel: string
}

const props = defineProps<{ open: boolean, route: TopologyRouteDetail | null, nodes: NodeData[] }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const hours = ref(24)

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const title = computed(() => props.route?.nodeNames.filter(Boolean).join(' → ') || '线路详情')

function scoreTone(score: TopologyRouteScore): string {
  if (score.tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (score.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (score.tone === 'pending')
    return 'text-slate-500 dark:text-slate-400'
  return 'text-emerald-700 dark:text-emerald-300'
}

function formatAvailability(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(value >= 99.95 ? 2 : 1)}%`
}

function formatLatency(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)} ms`
}

function formatDeviation(value: number | null): string {
  if (value === null)
    return '待数据'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

function baselineTone(reliability: TopologyRouteReliability): string {
  if (reliability.adaptive.tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (reliability.adaptive.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (reliability.adaptive.tone === 'healthy')
    return 'text-emerald-700 dark:text-emerald-300'
  return 'text-muted-foreground'
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    :title="title"
    description="查看每一段链路的实时延迟、丢包与历史波动。"
    content-class="max-w-4xl"
  >
    <div v-if="route" class="space-y-4">
      <section data-topology-score-detail class="grid gap-3 rounded-xl border border-border/60 bg-background/35 p-3.5 sm:grid-cols-[120px_1fr]">
        <div class="flex items-baseline gap-2 sm:block">
          <strong class="text-3xl font-semibold tabular-nums" :class="scoreTone(route.score)">{{ route.score.score }}</strong>
          <span data-topology-detail-score-label class="text-xs font-medium" :class="scoreTone(route.score)">{{ route.score.label }}</span>
          <div class="mt-1 hidden text-[10px] text-muted-foreground sm:block">
            线路健康评分
          </div>
        </div>
        <div class="min-w-0">
          <div class="flex min-w-0 items-center justify-between gap-3 text-[10px] text-muted-foreground">
            <span>主要扣分项</span>
            <span v-if="route.ranking && route.ranking.total > 1" data-topology-detail-ranking class="min-w-0 truncate text-right">
              {{ route.directionLabel }}第 {{ route.ranking.rank }} / {{ route.ranking.total }}
              <span v-if="route.ranking.recommended" class="ml-1 text-emerald-700 dark:text-emerald-300">推荐</span>
            </span>
          </div>
          <div v-if="route.score.deductions.length" class="mt-1.5 grid gap-1 sm:grid-cols-2">
            <div v-for="item in route.score.deductions.slice(0, 4)" :key="item.key" class="flex min-w-0 items-center justify-between gap-3 text-[11px]">
              <span class="truncate text-foreground/80">{{ item.label }}</span>
              <span class="shrink-0 tabular-nums text-muted-foreground">-{{ item.points }}</span>
            </div>
          </div>
          <div v-else class="mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
            当前没有明显扣分项
          </div>
          <div v-if="route.ranking?.recommended" class="mt-1.5 truncate text-[10px] text-muted-foreground" :title="route.ranking.reason">
            推荐依据：{{ route.ranking.reason }}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/50 pt-3 sm:col-span-2 sm:grid-cols-4">
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              24h 可用率
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatAvailability(route.reliability.day.availability) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.day.hasData ? `最弱分段 · ${route.reliability.day.sampleCount} 次` : `${route.reliability.completeSegments}/${route.reliability.totalSegments} 段有数据` }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              7d 可用率
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatAvailability(route.reliability.week.availability) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.week.hasData ? `最弱分段 · ${route.reliability.week.sampleCount} 次` : '历史数据待积累' }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              24h P95
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatLatency(route.reliability.day.p95Latency) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.day.p95Latency !== null ? '高位延迟参考' : route.reliability.day.hasData && route.reliability.totalSegments > 1 ? '需端到端样本' : '高位延迟参考' }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              相对智能基线
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums" :class="baselineTone(route.reliability)">
              {{ formatDeviation(route.reliability.adaptive.deviationPercent) }}
            </div>
            <div class="truncate text-[9px]" :class="baselineTone(route.reliability)">
              {{ route.reliability.adaptive.label }}
            </div>
          </div>
        </div>
      </section>

      <div class="flex items-center justify-between gap-3">
        <div class="text-xs text-muted-foreground">
          实时数据由探测来源节点执行绑定的 Ping 任务；上方视觉线路不代表反向探测。没有样本时显示备用基线。
        </div>
        <div class="flex shrink-0 rounded-md border border-border/60 bg-background/45 p-0.5" role="group" aria-label="线路历史时间范围">
          <button
            v-for="period in [{ value: 1, label: '1h' }, { value: 24, label: '24h' }, { value: 168, label: '7d' }]"
            :key="period.value"
            type="button"
            class="h-7 rounded px-2.5 text-[11px] text-muted-foreground transition-colors"
            :class="hours === period.value ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
            :aria-pressed="hours === period.value"
            @click="hours = period.value"
          >
            {{ period.label }}
          </button>
        </div>
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <TopologySegmentHistory
          v-for="(metric, index) in route.metrics.slice(0, Math.max(1, route.nodeNames.length - 1))"
          :key="`${route.key}-${index}`"
          :metric="metric"
          :nodes="nodes"
          :source-label="route.nodeNames[index] || `节点 ${index + 1}`"
          :target-label="route.nodeNames[index + 1] || `节点 ${index + 2}`"
          :hours="hours"
        />
      </div>
    </div>
  </AppDialog>
</template>
