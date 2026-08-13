<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsAlert } from '@/utils/pandaOpsAlert'
import { computed, onBeforeUnmount, watch } from 'vue'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { reportPandaOpsNodeAlert, resetPandaOpsNodeAlert } from '@/composables/usePandaOpsAlertState'
import { getPrimaryNodeAlert } from '@/utils/pandaOpsAlert'

const props = defineProps<{ node: NodeData }>()
const { carrierDisplays, carrierScopeLabel } = useNodeCarrierPingDisplay(() => props.node.uuid)
const candidate = computed<PandaOpsAlert | null>(() => getPrimaryNodeAlert(props.node, carrierDisplays.value, carrierScopeLabel.value))
const sampleToken = computed(() => {
  const carrierToken = carrierDisplays.value
    .map(carrier => carrier.latencyBars.at(-1)?.key ?? `${carrier.key}:empty`)
    .join('|')
  return `${props.node.time}|${candidate.value?.key ?? 'healthy'}|${candidate.value?.detail ?? ''}|${carrierToken}`
})

watch(
  [candidate, sampleToken],
  ([alert, token]) => reportPandaOpsNodeAlert(props.node.uuid, alert, token),
  { immediate: true },
)

onBeforeUnmount(() => resetPandaOpsNodeAlert(props.node.uuid))
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
