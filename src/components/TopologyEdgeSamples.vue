<script setup lang="ts">
import type { TelemetrySample } from '@/types/telemetry'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'

defineProps<{
  bars: TelemetrySample[]
  lineClass: string
  label: string
}>()
</script>

<template>
  <div
    data-topology-edge-line
    :data-topology-edge-sample-rail="bars.length ? '' : undefined"
    class="relative h-4 w-full min-w-0"
  >
    <span data-topology-edge-baseline class="pointer-events-none absolute inset-x-0 bottom-2 h-px" :class="lineClass" />
    <TelemetrySampleStrip
      v-if="bars.length"
      :samples="bars"
      :label="label"
      kind="topology"
      variant="ticks"
    />
  </div>
</template>
