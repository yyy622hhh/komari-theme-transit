<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsAlert } from '@/utils/pandaOpsAlert'
import { computed, onBeforeUnmount, watch } from 'vue'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { reportPandaOpsNodeAlert, resetPandaOpsNodeAlert, suppressPandaOpsNodeAlert } from '@/composables/usePandaOpsAlertState'
import { useAppStore } from '@/stores/app'
import { getPrimaryNodeAlert } from '@/utils/pandaOpsAlert'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()
const { carrierDisplays, carrierScopeLabel } = useNodeCarrierPingDisplay(() => props.node.uuid)
const isMaintenance = computed(() => Boolean(appStore.pandaOpsNodeControls[props.node.uuid]?.maintenanceUntil))
const candidate = computed<PandaOpsAlert | null>(() => isMaintenance.value
  ? null
  : getPrimaryNodeAlert(props.node, carrierDisplays.value, carrierScopeLabel.value))
const sampleToken = computed(() => {
  const carrierToken = carrierDisplays.value
    .map(carrier => carrier.latencyBars.at(-1)?.key ?? `${carrier.key}:empty`)
    .join('|')
  return `${props.node.time}|${candidate.value?.key ?? 'healthy'}|${candidate.value?.detail ?? ''}|${carrierToken}|maintenance:${isMaintenance.value}`
})

watch(
  [candidate, sampleToken, isMaintenance],
  ([alert, token, maintenance]) => maintenance
    ? suppressPandaOpsNodeAlert(props.node.uuid)
    : reportPandaOpsNodeAlert(props.node.uuid, alert, token),
  { immediate: true },
)

onBeforeUnmount(() => resetPandaOpsNodeAlert(props.node.uuid))
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
