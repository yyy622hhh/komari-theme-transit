<script setup lang="ts">
import type { PersonalWallpaperEffect } from '@/utils/wallpaper'
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { usePersonalWallpaper } from '@/composables/usePersonalWallpaper'
import { formatWallpaperFileSize } from '@/utils/wallpaper'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const wallpaper = usePersonalWallpaper()
const fileInput = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)

const effectOptions: Array<{
  key: PersonalWallpaperEffect
  label: string
  icon: string
  description: string
}> = [
  { key: 'glass', label: '玻璃化', icon: 'tabler:layers-subtract', description: '壁纸保持清晰，前景卡片使用更强的毛玻璃层次。' },
  { key: 'blur', label: '模糊', icon: 'tabler:blur', description: '对壁纸进行柔焦，减少复杂画面对内容的干扰。' },
  { key: 'hd', label: '高清', icon: 'tabler:photo', description: '保留原始画质，不增加模糊或额外滤镜。' },
]

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const previewStyle = computed(() => wallpaper.source.value
  ? { backgroundImage: `url(${wallpaper.source.value})` }
  : {})

const wallpaperDetails = computed(() => {
  const current = wallpaper.record.value
  if (!current)
    return ''
  return `${current.width} × ${current.height} · ${formatWallpaperFileSize(current.size)}`
})

watch(() => props.open, (open) => {
  if (open)
    void wallpaper.initialize()
}, { immediate: true })

function openFilePicker(): void {
  if (!fileInput.value)
    return
  fileInput.value.value = ''
  fileInput.value.click()
}

async function applyFile(file?: File): Promise<void> {
  if (!file)
    return
  try {
    await wallpaper.upload(file)
    window.$message?.success('本机壁纸已保存。')
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '壁纸保存失败。')
  }
}

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  void applyFile(input.files?.[0])
}

function handleDrop(event: DragEvent): void {
  dragActive.value = false
  if (wallpaper.busy.value)
    return
  void applyFile(event.dataTransfer?.files[0])
}

async function removeWallpaper(): Promise<void> {
  try {
    await wallpaper.remove()
    window.$message?.success('本机壁纸已移除。')
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '壁纸移除失败。')
  }
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="壁纸与背景效果"
    description="上传当前浏览器使用的高清壁纸，并选择玻璃化、模糊或高清显示。"
    content-class="max-w-2xl"
  >
    <div class="space-y-4" data-wallpaper-manager>
      <section
        class="overflow-hidden rounded-xl border border-border/70 bg-background/35"
        :aria-busy="wallpaper.busy.value"
      >
        <div
          class="relative aspect-[16/7] min-h-40 overflow-hidden bg-slate-950/90"
          :class="dragActive && 'ring-2 ring-inset ring-selection'"
          @dragenter.prevent="dragActive = true"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="handleDrop"
        >
          <div
            v-if="wallpaper.hasWallpaper.value"
            class="absolute inset-0 bg-cover bg-center"
            :style="previewStyle"
            data-wallpaper-preview
          />
          <div v-else class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,.28),transparent_42%),linear-gradient(135deg,#0f172a,#334155)]" />
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent" />
          <div class="absolute inset-x-0 bottom-0 flex flex-col items-stretch gap-3 p-3 text-white sm:flex-row sm:items-end sm:justify-between sm:p-4">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">
                {{ wallpaper.record.value?.name || '尚未上传本机壁纸' }}
              </p>
              <p class="mt-1 text-xs text-white/70">
                {{ wallpaperDetails || '支持 JPG、PNG、WebP、AVIF，最大 15 MB' }}
              </p>
            </div>
            <Button type="button" size="sm" class="w-full shrink-0 sm:w-auto" :disabled="wallpaper.busy.value" @click="openFilePicker">
              <Icon :icon="wallpaper.busy.value ? 'tabler:loader-2' : 'tabler:upload'" :class="wallpaper.busy.value && 'animate-spin'" />
              {{ wallpaper.hasWallpaper.value ? '更换壁纸' : '上传壁纸' }}
            </Button>
          </div>
          <input
            ref="fileInput"
            class="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            aria-label="选择本机壁纸"
            @change="handleFileChange"
          >
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
          <p class="flex items-start gap-1.5 text-[11px] leading-5 text-muted-foreground">
            <Icon icon="tabler:device-laptop" class="mt-0.5 shrink-0" />
            原图仅保存在当前浏览器，不会上传服务器；清理站点数据后需重新选择。
          </p>
          <Button
            v-if="wallpaper.hasWallpaper.value"
            type="button"
            variant="ghost"
            size="sm"
            class="text-destructive hover:text-destructive"
            :disabled="wallpaper.busy.value"
            @click="removeWallpaper"
          >
            <Icon icon="tabler:trash" />
            移除壁纸
          </Button>
        </div>
      </section>

      <fieldset>
        <legend class="mb-2 text-sm font-semibold text-foreground">
          显示效果
        </legend>
        <div class="grid gap-2 sm:grid-cols-3">
          <button
            v-for="option in effectOptions"
            :key="option.key"
            type="button"
            class="rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="wallpaper.effect.value === option.key
              ? 'border-selection/70 bg-selection/10 text-foreground'
              : 'border-border/70 bg-background/35 text-muted-foreground hover:bg-background/60'"
            :aria-pressed="wallpaper.effect.value === option.key"
            @click="wallpaper.setEffect(option.key)"
          >
            <span class="flex items-center gap-2 text-sm font-semibold">
              <Icon :icon="option.icon" :width="17" />
              {{ option.label }}
            </span>
            <span class="mt-1.5 block text-[11px] leading-5">{{ option.description }}</span>
          </button>
        </div>
      </fieldset>

      <p v-if="wallpaper.errorMessage.value" role="alert" class="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {{ wallpaper.errorMessage.value }}
      </p>
    </div>
  </AppDialog>
</template>
