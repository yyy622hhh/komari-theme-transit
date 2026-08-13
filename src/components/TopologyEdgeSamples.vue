<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { formatDateTime } from '@/utils/helper'

interface EdgeSampleBar {
  key: string
  height: number
  alert: boolean
  unavailable: boolean
  latency: number | null
  loss: number | null
  time: string
  segmentIndex: number
  segmentLabel: string
}

defineProps<{
  bars: EdgeSampleBar[]
  lineClass: string
}>()

const isTouchTooltipMode = ref(false)
const activeSampleKey = ref<string | null>(null)
let coarsePointerMediaQuery: MediaQueryList | null = null

function formatLatency(value: number | null): string {
  return value === null ? '无响应' : `${Math.round(value)} ms`
}

function formatLoss(value: number | null): string {
  if (value === null)
    return '-'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function syncTouchTooltipMode(): void {
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
</script>

<template>
  <div
    data-topology-edge-line
    :data-topology-edge-sample-rail="bars.length ? '' : undefined"
    class="relative flex h-4 min-w-2 max-w-16 flex-1 items-center gap-[2px]"
  >
    <span class="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2" :class="lineClass" />
    <TooltipProvider v-if="bars.length" :delay-duration="0" :skip-delay-duration="0" :disable-hoverable-content="true">
      <TooltipRoot
        v-for="bar in bars"
        :key="bar.key"
        :open="isTouchTooltipMode ? activeSampleKey === bar.key : undefined"
        @update:open="(open) => setSampleTooltipOpen(bar.key, open)"
      >
        <TooltipTrigger as-child>
          <button
            type="button"
            data-topology-sample
            :data-topology-sample-height="bar.height"
            class="group/sample relative z-1 flex h-full min-w-[3px] flex-1 cursor-default items-center justify-center focus-visible:outline-none"
            :aria-label="`${bar.segmentLabel}，${formatLatency(bar.latency)}，丢包 ${formatLoss(bar.loss)}，${formatDateTime(bar.time)}`"
            @click.stop="toggleSampleTooltip(bar.key)"
          >
            <span
              class="block w-0.5 rounded-full bg-emerald-400 transition-[filter,opacity] group-hover/sample:brightness-125 group-focus-visible/sample:ring-1 group-focus-visible/sample:ring-white/80"
              :class="bar.unavailable ? '!bg-rose-400 opacity-75' : bar.alert ? '!bg-amber-400' : ''"
              :style="{ height: `${bar.height}px` }"
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
    </TooltipProvider>
  </div>
</template>
