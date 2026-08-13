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
    class="relative h-10 min-w-[150px] flex-1"
  >
    <span data-topology-edge-baseline class="pointer-events-none absolute inset-x-0 bottom-2 h-px" :class="lineClass" />
    <div v-if="bars.length" class="absolute inset-x-2 bottom-0 flex h-4 items-center justify-between">
      <TooltipProvider :delay-duration="0" :skip-delay-duration="0" :disable-hoverable-content="true">
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
              class="group/sample relative z-1 flex h-4 min-w-3 flex-1 cursor-default items-center justify-center focus-visible:outline-none"
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
              :side-offset="9"
              class="z-50 min-w-28 rounded-lg border border-white/10 bg-[#101820]/96 px-3 py-2 text-slate-100 shadow-xl backdrop-blur-xl data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95"
            >
              <p class="text-xs font-semibold tabular-nums" :class="bar.unavailable ? 'text-rose-300' : bar.alert ? 'text-amber-300' : 'text-slate-100'">
                {{ formatLatency(bar.latency) }}
              </p>
              <p class="mt-1 text-[10px] tabular-nums" :class="bar.alert ? 'text-amber-300' : 'text-slate-300'">
                丢包 {{ formatLoss(bar.loss) }}
              </p>
              <p class="mt-0.5 text-[10px] tabular-nums text-slate-500">
                {{ formatDateTime(bar.time, 'HH:mm:ss') }}
              </p>
              <span class="sr-only">{{ bar.segmentLabel }}，第 {{ bar.segmentIndex + 1 }} 段</span>
              <TooltipArrow class="size-2.5 rotate-45 rounded-[2px] bg-[#101820]/96 fill-[#101820]" />
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
      </TooltipProvider>
    </div>
  </div>
</template>
