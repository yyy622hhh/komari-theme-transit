<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsAlert } from '@/utils/pandaOpsAlert'
import { onBeforeUnmount, watch } from 'vue'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { getCarrierNodeAlert } from '@/utils/pandaOpsAlert'

const props = defineProps<{ node: NodeData }>()
const emit = defineEmits<{ change: [alert: PandaOpsAlert | null] }>()
const { carrierDisplays, carrierScopeLabel } = useNodeCarrierPingDisplay(() => props.node.uuid)

watch(
  () => getCarrierNodeAlert(props.node, carrierDisplays.value, carrierScopeLabel.value),
  alert => emit('change', alert),
  { immediate: true },
)

onBeforeUnmount(() => emit('change', null))
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
