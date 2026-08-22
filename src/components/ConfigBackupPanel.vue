<script setup lang="ts">
import type { ThemeSettingsVersionEntry, ThemeSettingsVersionSource } from '@/utils/themeSettingsHistory'
import { Icon } from '@iconify/vue'
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { useThemeSettingsBackup } from '@/composables/useThemeSettingsBackup'
import { formatBeijingTime } from '@/utils/topologyReport'

const {
  history,
  importing,
  exporting,
  rollingBackAt,
  importPreview,
  importError,
  rollbackPreview,
  exportSettings,
  stageImportFile,
  cancelImport,
  confirmImport,
  stageRollback,
  cancelRollback,
  confirmRollback,
} = useThemeSettingsBackup()

const fileInput = ref<HTMLInputElement | null>(null)

function openFilePicker(): void {
  fileInput.value?.click()
}

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file)
    void stageImportFile(file)
}

const SOURCE_LABELS: Record<ThemeSettingsVersionSource, string> = {
  'initial': '首次记录',
  'external-change': '外部变更（含 Komari 后台）',
  'theme-write': '主题写入',
  'import': '导入',
  'rollback': '回滚',
}

function formatDiffValue(value: unknown): string {
  if (value === undefined)
    return '（无）'
  if (typeof value === 'string')
    return value.length > 60 ? `${value.slice(0, 60)}…` : value || '（空字符串）'
  return JSON.stringify(value)
}
</script>

<template>
  <div class="space-y-4">
    <CardX class="border-none bg-background/50">
      <template #header>
        <div>
          <h2 class="font-semibold">
            配置备份中心
          </h2>
          <div class="text-xs text-muted-foreground">
            导出/导入完整主题配置，保存/回滚最近 20 次版本，保存前均先显示差异。
          </div>
        </div>
      </template>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <input ref="fileInput" type="file" accept="application/json" class="hidden" @change="handleFileChange">
        <Button size="sm" variant="outline" class="bg-background/60" :disabled="importing" @click="openFilePicker">
          <Icon icon="tabler:upload" width="14" height="14" />
          导入配置
        </Button>
        <Button size="sm" :disabled="exporting" @click="exportSettings">
          <Icon :icon="exporting ? 'tabler:loader-2' : 'tabler:download'" width="14" height="14" :class="exporting && 'animate-spin'" />
          导出配置
        </Button>
      </div>
    </CardX>

    <div v-if="importError" class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <Icon icon="tabler:alert-triangle" width="14" height="14" class="mt-0.5 shrink-0" />
      {{ importError }}
    </div>

    <CardX v-if="importPreview" title="导入预览" size="small" class="border-none bg-background/50">
      <div class="space-y-3">
        <div class="text-xs text-muted-foreground">
          导出自 Transit {{ importPreview.themeVersion ?? '未知版本' }}，共 {{ importPreview.diff.length }} 项差异。确认后立即写入。
        </div>
        <ul v-if="importPreview.diff.length" class="max-h-64 space-y-1 overflow-y-auto text-xs">
          <li v-for="entry in importPreview.diff" :key="entry.key" class="flex flex-wrap items-baseline gap-x-2 rounded-md bg-background/60 px-2 py-1">
            <span class="font-mono">{{ entry.key }}</span>
            <span class="text-muted-foreground">{{ entry.kind === 'added' ? '新增' : entry.kind === 'removed' ? '移除' : '变更' }}</span>
            <span v-if="entry.kind !== 'added'" class="text-muted-foreground line-through">{{ formatDiffValue(entry.before) }}</span>
            <span v-if="entry.kind !== 'removed'" class="font-medium">{{ formatDiffValue(entry.after) }}</span>
          </li>
        </ul>
        <div v-else class="text-xs text-muted-foreground">
          与当前配置完全一致，没有需要写入的差异。
        </div>
        <div class="flex justify-end gap-2">
          <Button size="sm" variant="outline" class="bg-background/60" :disabled="importing" @click="cancelImport">
            取消
          </Button>
          <Button size="sm" :disabled="importing" @click="confirmImport">
            <Icon v-if="importing" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
            确认导入
          </Button>
        </div>
      </div>
    </CardX>

    <CardX v-if="rollbackPreview" title="回滚预览" size="small" class="border-none bg-background/50">
      <div class="space-y-3">
        <div class="text-xs text-muted-foreground">
          回滚到 {{ formatBeijingTime(rollbackPreview.entry.at) }} 的版本，共 {{ rollbackPreview.diff.length }} 项差异。确认后立即写入。
        </div>
        <ul v-if="rollbackPreview.diff.length" class="max-h-64 space-y-1 overflow-y-auto text-xs">
          <li v-for="entry in rollbackPreview.diff" :key="entry.key" class="flex flex-wrap items-baseline gap-x-2 rounded-md bg-background/60 px-2 py-1">
            <span class="font-mono">{{ entry.key }}</span>
            <span class="text-muted-foreground">{{ entry.kind === 'added' ? '新增' : entry.kind === 'removed' ? '移除' : '变更' }}</span>
            <span v-if="entry.kind !== 'added'" class="text-muted-foreground line-through">{{ formatDiffValue(entry.before) }}</span>
            <span v-if="entry.kind !== 'removed'" class="font-medium">{{ formatDiffValue(entry.after) }}</span>
          </li>
        </ul>
        <div v-else class="text-xs text-muted-foreground">
          与当前配置完全一致，没有需要写入的差异。
        </div>
        <div class="flex justify-end gap-2">
          <Button size="sm" variant="outline" class="bg-background/60" :disabled="Boolean(rollingBackAt)" @click="cancelRollback">
            取消
          </Button>
          <Button size="sm" variant="destructive" :disabled="Boolean(rollingBackAt)" @click="confirmRollback">
            <Icon v-if="rollingBackAt" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
            确认回滚
          </Button>
        </div>
      </div>
    </CardX>

    <CardX title="版本历史" size="small" class="border-none bg-background/50">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold">版本历史</span>
          <span class="text-xs font-normal text-muted-foreground">最多保留 {{ history.length }}/20 条，保存在本浏览器</span>
        </div>
      </template>
      <div v-if="!history.length" class="py-6 text-center text-sm text-muted-foreground">
        暂无记录，配置发生变化后会自动出现在这里。
      </div>
      <ul v-else class="space-y-1.5">
        <li v-for="(entry, index) in history" :key="entry.at" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/60 px-3 py-2 text-xs">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-mono">{{ formatBeijingTime(entry.at) }}</span>
            <span class="text-muted-foreground">{{ SOURCE_LABELS[entry.source] }}</span>
            <span v-if="index === 0" class="text-primary">当前</span>
          </div>
          <Button
            v-if="index !== 0"
            size="sm"
            variant="outline"
            class="h-6 bg-background/60 px-2 text-[11px]"
            :disabled="Boolean(rollingBackAt)"
            @click="stageRollback(entry as ThemeSettingsVersionEntry)"
          >
            <Icon :icon="rollingBackAt === entry.at ? 'tabler:loader-2' : 'tabler:history'" width="12" height="12" :class="rollingBackAt === entry.at && 'animate-spin'" />
            回滚到此版本
          </Button>
        </li>
      </ul>
    </CardX>
  </div>
</template>
