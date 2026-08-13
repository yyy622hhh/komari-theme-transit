<script setup lang="ts">
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'
import { useNodePingDisplay } from '@/composables/useNodePingDisplay'

const props = defineProps<{
  uuid: string
  online: boolean
  enabled: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const {
  latencyRenderBars,
  lossRenderBars,
} = useNodePingDisplay(() => props.uuid, { enabled: () => props.enabled })
</script>

<template>
  <div class="group relative flex w-full flex-col gap-[1px] pr-4 text-left">
    <button
      type="button"
      class="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60"
      aria-label="打开延迟和丢包监测"
      @click.stop="emit('click')"
    />
    <div class="group/panel relative z-1 items-center gap-1 opacity-80 hover:opacity-100">
      <div
        data-node-ping-bars="latency"
        class="h-3 min-w-0"
      >
        <TelemetrySampleStrip
          :samples="latencyRenderBars"
          label="列表延迟"
          kind="ping"
          variant="bars"
        />
      </div>
    </div>
    <div class="group/panel relative z-1 items-center gap-1 opacity-80 hover:opacity-100">
      <div
        data-node-ping-bars="loss"
        class="h-3 min-w-0"
      >
        <TelemetrySampleStrip
          :samples="lossRenderBars"
          label="列表丢包"
          kind="ping"
          variant="bars"
        />
      </div>
    </div>
  </div>
</template>
