<script setup lang="ts">
import type { PandaOpsIncidentEvent } from '@/composables/usePandaOpsIncidentTimeline'
import { Icon } from '@iconify/vue'
import { computed, ref } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { usePandaOpsIncidentTimeline } from '@/composables/usePandaOpsIncidentTimeline'
import { formatDateTime } from '@/utils/helper'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const range = ref<'today' | 'week'>('today')
const timeline = usePandaOpsIncidentTimeline()
const rangeOptions = [
  { value: 'today' as const, label: '今天' },
  { value: 'week' as const, label: '7 天' },
]

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const visibleEvents = computed(() => (range.value === 'today' ? timeline.todayEvents.value : timeline.events.value).slice(0, 80))

function eventIcon(event: PandaOpsIncidentEvent): string {
  if (event.type === 'started')
    return event.severity === 'critical' ? 'tabler:alert-triangle' : 'tabler:wave-sine'
  if (event.type === 'recovered')
    return 'tabler:circle-check'
  if (event.type === 'silenced' || event.type === 'silenceEnded')
    return event.type === 'silenced' ? 'tabler:bell-off' : 'tabler:bell'
  return event.type === 'maintenanceStarted' ? 'tabler:tools' : 'tabler:tool-off'
}

function eventTone(event: PandaOpsIncidentEvent): string {
  if (event.type === 'started')
    return event.severity === 'critical' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-700 dark:text-amber-300'
  if (event.type === 'recovered' || event.type === 'maintenanceEnded' || event.type === 'silenceEnded')
    return 'text-emerald-700 dark:text-emerald-300'
  return 'text-slate-600 dark:text-slate-300'
}

function durationText(durationMs?: number): string {
  if (!durationMs)
    return ''
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  if (minutes < 60)
    return `持续 ${minutes} 分钟`
  return `持续 ${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} 小时`
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="异常时间线"
    description="记录本浏览器观察到的告警、恢复、静默和维护事件。"
    content-class="max-w-2xl"
  >
    <div class="space-y-3" data-panda-incident-timeline>
      <div class="flex items-center justify-between gap-3">
        <div class="text-[11px] text-muted-foreground">
          自动保留最近 7 天，最多 200 条
        </div>
        <div class="flex rounded-md border border-border/60 bg-background/45 p-0.5">
          <button
            v-for="option in rangeOptions"
            :key="option.value"
            type="button"
            class="h-7 rounded px-2.5 text-[11px] transition-colors"
            :class="range === option.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="range = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div v-if="visibleEvents.length" class="max-h-[58vh] overflow-y-auto pr-1">
        <div class="relative ml-3 border-l border-border/60 pl-5">
          <article
            v-for="event in visibleEvents"
            :key="event.id"
            data-panda-incident-event
            class="relative pb-4 last:pb-0"
          >
            <span class="absolute -left-[29px] top-0 grid size-4 place-items-center rounded-full bg-card ring-2 ring-card">
              <Icon :icon="eventIcon(event)" :width="11" :class="eventTone(event)" />
            </span>
            <div class="flex min-w-0 items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate text-xs font-semibold text-foreground">
                  {{ event.nodeName }}
                </div>
                <div class="mt-0.5 text-[11px] leading-5" :class="eventTone(event)">
                  {{ event.detail }}
                </div>
              </div>
              <div class="shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">
                <div>{{ formatDateTime(new Date(event.timestamp), range === 'today' ? 'HH:mm:ss' : 'MM-DD HH:mm') }}</div>
                <div v-if="event.durationMs" class="mt-0.5">
                  {{ durationText(event.durationMs) }}
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div v-else class="rounded-xl border border-dashed border-border/60 px-4 py-9 text-center">
        <Icon icon="tabler:timeline-event" :width="24" class="mx-auto text-muted-foreground" />
        <div class="mt-2 text-sm font-medium">
          当前范围没有事件
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          告警开始、恢复和维护操作会自动记录在这里。
        </div>
      </div>
    </div>
  </AppDialog>
</template>
