<script setup lang="ts">
import type { AuditLogEntry } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { Spinner } from '@/components/ui/spinner'
import { loadAuditLogs } from '@/services/audit.service'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

const appStore = useAppStore()
const logs = ref<AuditLogEntry[]>([])
const total = ref(0)
const page = ref(1)
const limit = ref(50)
const loading = ref(false)
const error = ref<string | null>(null)
let requestId = 0

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
const pageStart = computed(() => total.value === 0 ? 0 : (page.value - 1) * limit.value + 1)
const pageEnd = computed(() => Math.min(total.value, page.value * limit.value))

function formatLogTime(time: string): string {
  return formatDateTime(time)
}

function normalizeLogLevel(type: string): string {
  return type?.trim() || '-'
}

function logLevelClass(type: string): string {
  const normalized = type.toLowerCase()
  if (normalized.includes('error') || normalized.includes('fail') || normalized.includes('delete'))
    return 'border-red-500/30 text-red-500'
  if (normalized.includes('warn') || normalized.includes('update') || normalized.includes('edit'))
    return 'border-orange-500/30 text-orange-500'
  return 'border-green-500/30 text-green-600'
}

async function fetchLogs(): Promise<void> {
  const granted = await appStore.requireLoginPermission('auditLog', { force: false })
  if (!granted) {
    error.value = '登录状态已过期，请重新登录后查看审计日志。'
    logs.value = []
    total.value = 0
    return
  }

  const currentRequestId = ++requestId
  loading.value = true
  error.value = null

  try {
    const result = await loadAuditLogs({ page: page.value, limit: limit.value })
    if (currentRequestId !== requestId)
      return
    logs.value = result.logs ?? []
    total.value = Number.isFinite(result.total) ? result.total : logs.value.length
    if (page.value > totalPages.value)
      page.value = totalPages.value
  }
  catch (err) {
    if (currentRequestId !== requestId)
      return
    error.value = err instanceof Error ? err.message : '获取审计日志失败'
    logs.value = []
    total.value = 0
  }
  finally {
    if (currentRequestId === requestId)
      loading.value = false
  }
}

function setPage(nextPage: number): void {
  page.value = Math.min(Math.max(1, nextPage), totalPages.value)
}

watch([page, limit], () => {
  void fetchLogs()
})

onMounted(() => {
  void fetchLogs()
})
</script>

<template>
  <div class="space-y-4">
    <CardX class="border-none bg-background/50">
      <template #header>
        <div>
          <div class="font-semibold">
            管理员操作审计日志
          </div>
          <div class="text-xs text-muted-foreground">
            只读查看后端 admin:getLogs 记录，默认每页 {{ limit }} 条。
          </div>
        </div>
      </template>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="text-sm text-muted-foreground">
          <template v-if="total > 0">
            当前显示 {{ pageStart }}-{{ pageEnd }} / {{ total }} 条
          </template>
          <template v-else>
            暂无可显示的审计日志
          </template>
        </div>
        <Button size="sm" variant="outline" class="bg-background/60" :disabled="loading" @click="fetchLogs">
          <Icon :icon="loading ? 'tabler:loader-2' : 'tabler:refresh'" width="14" height="14" :class="loading && 'animate-spin'" />
          {{ loading ? '刷新中' : '刷新' }}
        </Button>
      </div>
    </CardX>

    <CardX class="border-none bg-background/50" content-class="overflow-x-auto">
      <template #header>
        <div class="font-semibold">
          日志列表
        </div>
      </template>
      <Spinner :show="loading">
        <div v-if="error" class="py-8 text-center text-sm text-red-500">
          {{ error }}
        </div>
        <table v-else-if="logs.length" class="min-w-[900px] w-full text-left text-sm">
          <thead class="text-xs text-muted-foreground">
            <tr class="border-b border-border/60">
              <th class="px-2 py-2 font-medium">
                时间
              </th>
              <th class="px-2 py-2 font-medium">
                IP
              </th>
              <th class="px-2 py-2 font-medium">
                操作者
              </th>
              <th class="px-2 py-2 font-medium">
                级别
              </th>
              <th class="px-2 py-2 font-medium">
                内容
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id" class="border-b border-border/40 last:border-0">
              <td class="whitespace-nowrap px-2 py-3 text-xs tabular-nums text-muted-foreground">
                {{ formatLogTime(log.time) }}
              </td>
              <td class="whitespace-nowrap px-2 py-3 text-xs tabular-nums">
                {{ log.ip || '-' }}
              </td>
              <td class="max-w-[14rem] px-2 py-3 text-xs text-muted-foreground">
                <!-- TODO: 后端当前只返回 uuid，暂不做用户名反查。 -->
                <span class="block truncate" :title="log.uuid">{{ log.uuid || '-' }}</span>
              </td>
              <td class="px-2 py-3">
                <Badge variant="outline" class="rounded-md text-[11px]" :class="logLevelClass(log.msg_type)">
                  {{ normalizeLogLevel(log.msg_type) }}
                </Badge>
              </td>
              <td class="px-2 py-3">
                <span class="whitespace-pre-wrap break-words">{{ log.message || '-' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="py-10 text-center text-sm text-muted-foreground">
          暂无审计日志。
        </div>
      </Spinner>
    </CardX>

    <div class="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" class="bg-background/50" :disabled="loading || page <= 1" @click="setPage(page - 1)">
        上一页
      </Button>
      <span class="text-xs text-muted-foreground tabular-nums">{{ page }} / {{ totalPages }}</span>
      <Button size="sm" variant="outline" class="bg-background/50" :disabled="loading || page >= totalPages" @click="setPage(page + 1)">
        下一页
      </Button>
    </div>
  </div>
</template>
