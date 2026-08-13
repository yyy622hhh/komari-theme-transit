<script setup lang="ts">
import type { TelemetrySample } from '@/types/telemetry'
import { onClickOutside } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { subscribeTelemetryViewportRefresh } from '@/composables/useTelemetryViewportRefresh'

const props = withDefaults(defineProps<{
  samples: TelemetrySample[]
  label: string
  kind: 'topology' | 'carrier' | 'ping'
  variant?: 'ticks' | 'bars'
}>(), {
  variant: 'bars',
})

const root = ref<HTMLElement | null>(null)
const activeIndex = ref<number | null>(null)
const pinned = ref(false)
const tooltipId = useId()
const tooltipPosition = ref({ left: 0, top: 0, below: false })
let stopViewportRefresh: (() => void) | null = null

const activeSample = computed(() => activeIndex.value === null ? null : props.samples[activeIndex.value] ?? null)

const rootClass = computed(() => props.variant === 'ticks'
  ? 'absolute inset-x-2 bottom-0 flex h-4 items-center justify-between outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/70 dark:focus-visible:ring-emerald-300/70'
  : 'grid h-3 min-w-0 grid-flow-col auto-cols-fr items-center gap-px rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/70 dark:focus-visible:ring-emerald-300/70')

const sampleButtonClass = computed(() => props.variant === 'ticks'
  ? 'group/sample relative z-1 flex h-4 min-w-3 flex-1 cursor-pointer items-center justify-center focus:outline-none'
  : 'group/sample flex h-3 min-w-0 cursor-pointer items-center focus:outline-none')

const sampleMarkClass = computed(() => props.variant === 'ticks'
  ? 'block w-0.5 rounded-full transition-[filter,transform] group-hover/sample:scale-y-125 group-hover/sample:brightness-125'
  : 'block h-1 w-full rounded-[1px] transition-[filter,transform] group-hover/sample:scale-y-150 group-hover/sample:brightness-125')

const activeTextClass = computed(() => {
  if (activeSample.value?.tone === 'critical')
    return 'text-rose-600 dark:text-rose-300'
  if (activeSample.value?.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (activeSample.value?.tone === 'notice')
    return 'text-lime-700 dark:text-lime-300'
  if (activeSample.value?.tone === 'muted')
    return 'text-slate-500 dark:text-slate-400'
  return 'text-emerald-700 dark:text-emerald-300'
})

function closeTooltip(): void {
  activeIndex.value = null
  pinned.value = false
}

function positionTooltip(target: HTMLElement): void {
  const rect = target.getBoundingClientRect()
  const below = rect.top < 104
  tooltipPosition.value = {
    left: Math.min(Math.max(rect.left + rect.width / 2, 96), window.innerWidth - 96),
    top: below ? rect.bottom + 9 : rect.top - 9,
    below,
  }
}

function openTooltip(index: number, target: HTMLElement): void {
  activeIndex.value = index
  positionTooltip(target)
}

function getSampleElement(index: number): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-sample-index="${index}"]`) ?? null
}

function showSample(index: number): void {
  const target = getSampleElement(index)
  if (target)
    openTooltip(index, target)
}

function handlePointerEnter(event: PointerEvent, index: number): void {
  if (!pinned.value)
    openTooltip(index, event.currentTarget as HTMLElement)
}

function handlePointerLeave(): void {
  if (!pinned.value && !root.value?.matches(':focus-within'))
    activeIndex.value = null
}

function toggleSample(event: MouseEvent, index: number): void {
  event.stopPropagation()
  if (pinned.value && activeIndex.value === index) {
    closeTooltip()
    return
  }
  pinned.value = true
  openTooltip(index, event.currentTarget as HTMLElement)
}

function handleFocus(): void {
  if (activeIndex.value === null && props.samples.length)
    showSample(props.samples.length - 1)
}

function handleFocusOut(event: FocusEvent): void {
  if (!pinned.value && !root.value?.contains(event.relatedTarget as Node | null))
    activeIndex.value = null
}

function handleKeyboard(event: KeyboardEvent): void {
  if (!props.samples.length)
    return

  const lastIndex = props.samples.length - 1
  const currentIndex = activeIndex.value ?? lastIndex
  let nextIndex = currentIndex

  if (event.key === 'ArrowLeft') {
    nextIndex = Math.max(0, currentIndex - 1)
  }
  else if (event.key === 'ArrowRight') {
    nextIndex = Math.min(lastIndex, currentIndex + 1)
  }
  else if (event.key === 'Home') {
    nextIndex = 0
  }
  else if (event.key === 'End') {
    nextIndex = lastIndex
  }
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    pinned.value = !pinned.value
    showSample(currentIndex)
    return
  }
  else if (event.key === 'Escape') {
    event.preventDefault()
    closeTooltip()
    root.value?.focus()
    return
  }
  else {
    return
  }

  event.preventDefault()
  pinned.value = false
  showSample(nextIndex)
}

function refreshTooltipPosition(): void {
  if (activeIndex.value !== null)
    showSample(activeIndex.value)
}

watch(activeIndex, (index) => {
  if (index !== null && !stopViewportRefresh) {
    stopViewportRefresh = subscribeTelemetryViewportRefresh(refreshTooltipPosition)
  }
  else if (index === null && stopViewportRefresh) {
    stopViewportRefresh()
    stopViewportRefresh = null
  }
})

onBeforeUnmount(() => {
  stopViewportRefresh?.()
  stopViewportRefresh = null
})

onClickOutside(root, closeTooltip)
</script>

<template>
  <div
    ref="root"
    data-sample-strip
    :data-sample-kind="kind"
    :class="rootClass"
    role="group"
    tabindex="0"
    :aria-label="`${label}历史采样，左右方向键切换，回车固定`"
    :aria-describedby="activeSample ? tooltipId : undefined"
    @focus="handleFocus"
    @focusout="handleFocusOut"
    @keydown="handleKeyboard"
    @pointerleave="handlePointerLeave"
  >
    <button
      v-for="(sample, index) in samples"
      :key="sample.key"
      type="button"
      data-sample-trigger
      :data-sample-index="index"
      :data-topology-sample="kind === 'topology' ? '' : undefined"
      :data-carrier-sample="kind === 'carrier' ? '' : undefined"
      :data-node-ping-sample="kind === 'ping' ? '' : undefined"
      :data-topology-sample-height="kind === 'topology' ? sample.height : undefined"
      tabindex="-1"
      :class="sampleButtonClass"
      :aria-label="sample.ariaLabel"
      :aria-pressed="pinned && activeIndex === index"
      @pointerenter="handlePointerEnter($event, index)"
      @focus="openTooltip(index, $event.currentTarget as HTMLElement)"
      @click="toggleSample($event, index)"
    >
      <span
        :class="[
          sampleMarkClass,
          sample.toneClass,
          activeIndex === index ? (variant === 'ticks' ? 'scale-y-125 brightness-125' : 'scale-y-150 brightness-125') : '',
        ]"
        :style="variant === 'ticks' ? { height: `${sample.height ?? 7}px` } : undefined"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="activeSample"
        :id="tooltipId"
        data-sample-tooltip
        :data-sample-kind="kind"
        :data-topology-sample-detail="kind === 'topology' ? '' : undefined"
        :data-carrier-sample-tooltip="kind === 'carrier' ? '' : undefined"
        :data-node-ping-sample-tooltip="kind === 'ping' ? '' : undefined"
        role="tooltip"
        class="pointer-events-none fixed z-50 min-w-32 rounded-lg border border-slate-900/10 bg-white/96 px-3 py-2 text-[10px] text-slate-700 shadow-[0_12px_34px_rgb(15_23_42/0.2)] backdrop-blur-xl dark:border-white/10 dark:bg-[#101820]/96 dark:text-slate-300 dark:shadow-xl"
        :style="{
          left: `${tooltipPosition.left}px`,
          top: `${tooltipPosition.top}px`,
          transform: tooltipPosition.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        }"
      >
        <div v-if="activeSample.title" class="mb-1 text-[9px] font-medium text-slate-500">
          {{ activeSample.title }}
        </div>
        <div class="flex items-center justify-between gap-4">
          <strong class="font-semibold tabular-nums" :class="activeTextClass">{{ activeSample.valueText }}</strong>
          <strong v-if="activeSample.secondaryText" class="font-medium tabular-nums text-slate-700 dark:text-slate-300">{{ activeSample.secondaryText }}</strong>
        </div>
        <div v-if="activeSample.timeText" class="mt-1 tabular-nums text-slate-500">
          {{ activeSample.timeText }}
        </div>
      </div>
    </Teleport>
  </div>
</template>
