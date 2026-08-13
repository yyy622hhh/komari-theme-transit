<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed, ref } from 'vue'
import TopologySegmentHistory from '@/components/TopologySegmentHistory.vue'
import { AppDialog } from '@/components/ui/app-dialog'

export interface TopologyRouteDetail {
  key: string
  nodeNames: string[]
  metrics: string[]
}

const props = defineProps<{ open: boolean, route: TopologyRouteDetail | null, nodes: NodeData[] }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const hours = ref(24)

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const title = computed(() => props.route?.nodeNames.filter(Boolean).join(' → ') || '线路详情')
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    :title="title"
    description="查看每一段链路的实时延迟、丢包与历史波动。"
    content-class="max-w-4xl"
  >
    <div v-if="route" class="space-y-4">
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
