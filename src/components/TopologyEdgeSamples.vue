<script setup lang="ts">
import type { TelemetrySample } from '@/types/telemetry'
import { Icon } from '@iconify/vue'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'

defineProps<{
  bars: TelemetrySample[]
  lineClass: string
  label: string
  direction?: 'reverse' | 'forward'
  vertical?: boolean
}>()
</script>

<template>
  <div
    data-topology-edge-line
    :data-topology-edge-sample-rail="bars.length ? '' : undefined"
    :data-topology-probe-direction="direction"
    class="relative h-4 w-full min-w-0"
  >
    <span data-topology-edge-baseline class="pointer-events-none absolute inset-x-0 bottom-2 h-px" :class="lineClass" />
    <Icon v-if="direction" :icon="vertical ? (direction === 'reverse' ? 'tabler:arrow-up' : 'tabler:arrow-down') : (direction === 'reverse' ? 'tabler:arrow-left' : 'tabler:arrow-right')" aria-hidden="true" width="16" class="pointer-events-none absolute top-0 z-2 text-muted-foreground" :class="direction === 'reverse' ? 'left-0' : 'right-0'" />
    <TelemetrySampleStrip
      v-if="bars.length"
      :samples="bars"
      :label="label"
      kind="topology"
      variant="ticks"
    />
  </div>
</template>
