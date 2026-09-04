<script setup lang="ts">
import { Icon } from '@iconify/vue/offline'
import { nextTick, onErrorCaptured, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { logAppError } from '@/utils/safeError'

const props = withDefaults(defineProps<{
  label?: string
  resetKey?: string | number
}>(), {
  label: '此区域',
  resetKey: '',
})

const failed = ref(false)
const rendering = ref(true)
const retryAttempt = ref(0)

onErrorCaptured((error, _instance, info) => {
  logAppError(`${props.label} render failed (${info})`, error)
  failed.value = true
  return false
})

watch(() => props.resetKey, () => {
  failed.value = false
  rendering.value = true
  retryAttempt.value = 0
})

async function retry(): Promise<void> {
  failed.value = false
  rendering.value = false
  retryAttempt.value += 1
  await nextTick()
  rendering.value = true
}
</script>

<template>
  <slot v-if="rendering && !failed" :retry-attempt="retryAttempt" />
  <div
    v-else
    class="mx-4 flex min-h-32 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center"
    role="alert"
  >
    <Icon icon="tabler:alert-triangle" class="size-6 text-destructive" aria-hidden="true" />
    <div>
      <p class="text-sm font-medium text-foreground">
        {{ label }}暂时无法显示
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        其他功能不受影响，可以单独重试此区域。
      </p>
    </div>
    <Button type="button" size="sm" variant="outline" @click="retry">
      <Icon icon="tabler:refresh" aria-hidden="true" />
      重试
    </Button>
  </div>
</template>
