<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

interface Props {
  size?: number | string
  stroke?: number | string
  show?: boolean
  description?: string
  contentClass?: HTMLAttributes['class']
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  size: 24,
  stroke: 2,
  show: true,
})

function toSize(v: number | string) {
  return typeof v === 'number' ? `${v}px` : v
}
</script>

<template>
  <div :class="cn('relative', props.class)" :aria-busy="show">
    <div class="contents" :inert="show || undefined">
      <slot />
    </div>
    <div
      v-if="show"
      role="status"
      aria-live="polite"
      :class="cn(
        'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-card/60 backdrop-blur-sm',
        props.contentClass,
      )"
    >
      <span
        aria-hidden="true"
        class="inline-block animate-spin rounded-full border-solid"
        :style="{
          width: toSize(size),
          height: toSize(size),
          borderWidth: toSize(stroke),
          borderColor: 'color-mix(in srgb, currentColor 18%, transparent)',
          borderTopColor: 'currentColor',
        }"
      />
      <span v-if="description || $slots.description" class="text-sm text-muted-foreground">
        <slot name="description">{{ description }}</slot>
      </span>
      <span v-else class="sr-only">加载中</span>
    </div>
  </div>
</template>
