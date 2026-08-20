<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { dismissMessage, messageItems } from '@/utils/message'

const messagePresentation = {
  success: {
    icon: 'lucide:circle-check',
    class: 'border-emerald-500/35 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50',
  },
  error: {
    icon: 'lucide:octagon-x',
    class: 'border-destructive/40 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-50',
  },
  warning: {
    icon: 'lucide:triangle-alert',
    class: 'border-amber-500/40 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50',
  },
  info: {
    icon: 'lucide:info',
    class: 'border-sky-500/35 bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-50',
  },
} as const
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
      aria-atomic="false"
    >
      <TransitionGroup name="toast">
        <div
          v-for="item in messageItems"
          :key="item.id"
          :role="item.kind === 'error' ? 'alert' : 'status'"
          class="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-md"
          :class="messagePresentation[item.kind].class"
        >
          <Icon :icon="messagePresentation[item.kind].icon" class="size-4 shrink-0" />
          <span class="min-w-0 flex-1">{{ item.text }}</span>
          <button
            type="button"
            class="-mr-1 rounded-md p-1 opacity-65 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2"
            aria-label="关闭通知"
            @click="dismissMessage(item.id)"
          >
            <Icon icon="lucide:x" class="size-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-0.5rem) scale(0.98);
}
</style>
