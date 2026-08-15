<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'

const props = withDefaults(defineProps<{
  error?: string | null
  empty?: boolean
  emptyDescription?: string
}>(), {
  error: null,
  empty: false,
  emptyDescription: '暂无数据',
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div v-if="props.error" class="flex flex-col items-center gap-3 py-8 text-center text-red-500" role="alert">
    <p>{{ props.error }}</p>
    <Button type="button" size="sm" variant="outline" @click="emit('retry')">
      重试
    </Button>
  </div>
  <Empty v-else-if="props.empty" :description="props.emptyDescription" />
</template>
