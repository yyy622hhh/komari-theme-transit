<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { computed, ref, useId } from 'vue'

interface SampleBar {
  key: string
  className: string
  tooltip: string
}

const props = defineProps<{
  bars: SampleBar[]
  label: string
}>()

const root = ref<HTMLElement | null>(null)
const activeIndex = ref<number | null>(null)
const pinned = ref(false)
const tooltipId = useId()
const tooltipPosition = ref({ left: 0, top: 0, below: false })

const activeBar = computed(() => activeIndex.value === null ? null : props.bars[activeIndex.value] ?? null)
const tooltipLines = computed(() => activeBar.value?.tooltip.split('\n').filter(Boolean) ?? [])

function closeTooltip(): void {
  activeIndex.value = null
  pinned.value = false
}

function positionTooltip(target: HTMLElement): void {
  const rect = target.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const below = rect.top < 90
  tooltipPosition.value = {
    left: Math.min(Math.max(rect.left + rect.width / 2, 92), viewportWidth - 92),
    top: below ? rect.bottom + 8 : rect.top - 8,
    below,
  }
}

function openTooltip(index: number, target: HTMLElement): void {
  activeIndex.value = index
  positionTooltip(target)
}

function getSampleElement(index: number): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-carrier-sample-index="${index}"]`) ?? null
}

function showSample(index: number): void {
  const target = getSampleElement(index)
  if (target)
    openTooltip(index, target)
}

function handlePointerEnter(event: PointerEvent, index: number): void {
  if (pinned.value)
    return
  openTooltip(index, event.currentTarget as HTMLElement)
}

function handlePointerLeave(): void {
  if (pinned.value || root.value?.matches(':focus-within'))
    return
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
  if (activeIndex.value !== null || !props.bars.length)
    return
  showSample(props.bars.length - 1)
}

function handleFocusOut(event: FocusEvent): void {
  if (pinned.value || root.value?.contains(event.relatedTarget as Node | null))
    return
  activeIndex.value = null
}

function handleKeyboard(event: KeyboardEvent): void {
  if (!props.bars.length)
    return

  const lastIndex = props.bars.length - 1
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

onClickOutside(root, closeTooltip)
</script>

<template>
  <div
    ref="root"
    class="pointer-events-auto grid h-3 min-w-0 grid-flow-col auto-cols-fr items-center gap-px rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-emerald-300/70"
    role="group"
    tabindex="0"
    :aria-label="`${label}历史采样，左右方向键切换`"
    :aria-describedby="activeBar ? tooltipId : undefined"
    @focus="handleFocus"
    @focusout="handleFocusOut"
    @keydown="handleKeyboard"
    @pointerleave="handlePointerLeave"
  >
    <button
      v-for="(bar, index) in bars"
      :key="bar.key"
      type="button"
      data-carrier-sample
      :data-carrier-sample-index="index"
      tabindex="-1"
      class="group/sample flex h-3 min-w-0 cursor-pointer items-center focus:outline-none"
      :aria-label="bar.tooltip.split('\n').join('，')"
      :aria-pressed="pinned && activeIndex === index"
      @pointerenter="handlePointerEnter($event, index)"
      @focus="openTooltip(index, $event.currentTarget as HTMLElement)"
      @click="toggleSample($event, index)"
    >
      <span
        class="block h-1 w-full rounded-[1px] transition-[filter,transform] group-hover/sample:scale-y-150 group-hover/sample:brightness-125"
        :class="[bar.className, activeIndex === index ? 'scale-y-150 brightness-125' : '']"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="activeBar"
        :id="tooltipId"
        data-carrier-sample-tooltip
        role="tooltip"
        class="pointer-events-none fixed z-50 min-w-32 rounded-lg border border-white/10 bg-[#101820]/95 px-3 py-2 text-[10px] text-slate-300 shadow-xl backdrop-blur-xl"
        :style="{
          left: `${tooltipPosition.left}px`,
          top: `${tooltipPosition.top}px`,
          transform: tooltipPosition.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        }"
      >
        <div v-if="tooltipLines.length >= 3" class="space-y-1">
          <div class="flex items-center justify-between gap-4">
            <strong class="font-semibold text-slate-100">{{ tooltipLines[0] }}</strong>
            <strong class="font-semibold tabular-nums text-emerald-300">{{ tooltipLines[2] }}</strong>
          </div>
          <div class="tabular-nums text-slate-500">
            {{ tooltipLines[1] }}
          </div>
        </div>
        <div v-else>
          {{ tooltipLines.join(' · ') }}
        </div>
      </div>
    </Teleport>
  </div>
</template>
