<script setup lang="ts">
import { onBeforeMount } from 'vue'

const props = defineProps<{
  attempt: number
}>()

onBeforeMount(() => {
  if (props.attempt === 0)
    throw new Error('token=boundary-secret-canary')
})
</script>

<template>
  <p data-testid="boundary-recovered">
    组件已恢复
  </p>
</template>
