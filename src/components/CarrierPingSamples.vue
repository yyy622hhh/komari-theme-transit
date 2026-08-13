<script setup lang="ts">
import type { TelemetrySample } from '@/types/telemetry'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'

defineProps<{
  bars: TelemetrySample[]
  label: string
}>()
</script>

<template>
  <TelemetrySampleStrip
    :samples="bars"
    :label="label"
    kind="carrier"
    variant="bars"
    class="pointer-events-auto"
  />
</template>
