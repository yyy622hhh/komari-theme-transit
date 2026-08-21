<script setup lang="ts">
import { Icon } from '@iconify/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

defineProps<{
  open: boolean
  title: string
  description?: string
  contentClass?: string
  /** 可选：标题左侧的图标方块，不传就还是纯文字标题。 */
  icon?: string
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-100 bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-101 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/95 text-card-foreground shadow-2xl backdrop-blur-xl focus:outline-none"
        :class="contentClass"
      >
        <div class="flex items-start gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
          <div v-if="icon" class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60">
            <Icon :icon="icon" width="18" height="18" />
          </div>
          <div class="min-w-0 flex-1">
            <DialogTitle class="truncate text-base font-semibold">
              {{ title }}
            </DialogTitle>
            <DialogDescription class="mt-0.5 text-xs text-muted-foreground" :class="!description && 'sr-only'">
              {{ description || title }}
            </DialogDescription>
          </div>
          <DialogClose as-child>
            <button
              type="button"
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="关闭"
            >
              <Icon icon="tabler:x" width="17" height="17" />
            </button>
          </DialogClose>
        </div>
        <!--
          可滚动区域必须能被键盘聚焦，否则只能用鼠标滚动（axe
          scrollable-region-focusable，serious）。axe 也接受「区域内含可聚焦元素」，
          但对话框正文在数据到位前可能一个可聚焦子元素都没有，于是这条违规会随渲染
          时序间歇出现；把 tabindex 放在容器上才是与内容无关的稳定修法。
        -->
        <div
          class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          tabindex="0"
          role="group"
          :aria-label="title"
        >
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
