<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteScore } from '@/utils/topologyHealth'
import { computed, ref } from 'vue'
import TopologySegmentHistory from '@/components/TopologySegmentHistory.vue'
import { AppDialog } from '@/components/ui/app-dialog'

export interface TopologyRouteDetail {
  key: string
  nodeNames: string[]
  metrics: string[]
  score: TopologyRouteScore
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
          <span class="text-xs font-medium" :class="scoreTone(route.score)">{{ route.score.label }}</span>
          <div class="mt-1 hidden text-[10px] text-muted-foreground sm:block">
            线路健康评分
          </div>
        </div>
        <div class="min-w-0">
          <div class="text-[10px] text-muted-foreground">
            主要扣分项
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
        </div>
      </section>

      <div class="flex items-center justify-between gap-3">
        <div class="text-xs text-muted-foreground">
          数据来自该段配置的 Komari Ping 任务；没有任务时显示备用基线。
        </div>
        <div class="flex shrink-0 rounded-md border border-border/60 bg-background/45 p-0.5">
          <button
            v-for="period in [{ value: 1, label: '1h' }, { value: 24, label: '24h' }, { value: 168, label: '7d' }]"
            :key="period.value"
            type="button"
            class="h-7 rounded px-2.5 text-[11px] text-muted-foreground transition-colors"
            :class="hours === period.value ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
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
