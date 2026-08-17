<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { NodeAlert } from '@/utils/nodeAlert'
import { computed, onBeforeUnmount, watch } from 'vue'
import { reportNodeAlert, resetNodeAlert, suppressNodeAlert } from '@/composables/useNodeAlertState'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { useAppStore } from '@/stores/app'
import { getPrimaryNodeAlert } from '@/utils/nodeAlert'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()
const { carrierDisplays, carrierScopeLabel } = useNodeCarrierPingDisplay(() => props.node.uuid)
const isMaintenance = computed(() => Boolean(appStore.nodeControls[props.node.uuid]?.maintenanceUntil))
const candidate = computed<NodeAlert | null>(() => isMaintenance.value
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
    ? suppressNodeAlert(props.node.uuid)
    : reportNodeAlert(props.node.uuid, alert, token),
  { immediate: true },
)

onBeforeUnmount(() => resetNodeAlert(props.node.uuid))
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
