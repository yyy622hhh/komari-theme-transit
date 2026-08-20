<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import TopologyManagerContent from '@/components/TopologyManagerContent.vue'
import { useTopologyManagerDialog } from '@/composables/useTopologyManagerDialog'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const context = useTopologyManagerDialog(props, open => emit('update:open', open))
</script>

<template>
  <TopologyManagerContent :context="context" />
</template>
