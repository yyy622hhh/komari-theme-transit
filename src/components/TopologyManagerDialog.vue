<script setup lang="ts">
import type { TopologyManager } from '@/composables/useTopologyManager'
import type { NodeData } from '@/stores/nodes'
import TopologyManagerContent from '@/components/TopologyManagerContent.vue'
import { useTopologyManagerDialog } from '@/composables/useTopologyManagerDialog'

const props = defineProps<{
  nodes: NodeData[]
  open: boolean
  manager?: TopologyManager
  waitForRepairIdle?: () => Promise<void>
}>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const context = useTopologyManagerDialog(
  props,
  open => emit('update:open', open),
  { manager: props.manager, waitForRepairIdle: props.waitForRepairIdle },
)
</script>

<template>
  <TopologyManagerContent :context="context" />
</template>
