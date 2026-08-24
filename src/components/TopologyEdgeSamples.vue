<script setup lang="ts">
import type { TelemetrySample } from '@/types/telemetry'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'

withDefaults(defineProps<{
  bars: TelemetrySample[]
  lineClass: string
  label: string
  staticBaseline?: boolean
}>(), {
  staticBaseline: false,
})
</script>

<template>
  <div
    data-topology-edge-line
    :data-topology-edge-sample-rail="bars.length || staticBaseline ? '' : undefined"
    class="relative h-10 min-w-[150px] flex-1"
  >
    <span data-topology-edge-baseline class="pointer-events-none absolute inset-x-0 bottom-2 h-px" :class="lineClass" />
    <TelemetrySampleStrip
      v-if="bars.length"
      :samples="bars"
      :label="label"
      kind="topology"
      variant="ticks"
    />
    <div
      v-else-if="staticBaseline"
      data-topology-static-samples
      class="pointer-events-none absolute inset-x-2 bottom-0 flex h-4 items-center justify-between"
      aria-hidden="true"
    >
      <span
        v-for="index in 10"
        :key="index"
        class="h-1.5 w-0.5 rounded-full bg-slate-400/55 dark:bg-slate-500/55"
      />
    </div>
  </div>
</template>
