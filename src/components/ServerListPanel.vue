<script setup lang="ts">
import type { ServerListSortKey, ServerListStatusFilter } from '@/services/server-list.service'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useServerList } from '@/composables/useServerList'
import { useSortableOrder } from '@/composables/useSortableOrder'
import { useAppStore } from '@/stores/app'
import {
  formatBytesPerSecondWithConfig,
  formatBytesWithConfig,
  formatDateTime,
  getStatus,
} from '@/utils/helper'
import { getRegionDisplayName } from '@/utils/regionHelper'

const props = defineProps<{
  canEditOrder: boolean
  nodes: NodeData[]
}>()

const emit = defineEmits<{
  manageNode: [node: NodeData]
  openNode: [node: NodeData]
}>()

const appStore = useAppStore()
const {
  beginOrderEdit,
  cancelOrderEdit,
  editingOrder,
  moveOrderToIndex,
  orderDirty,
  persistOrder,
  query,
  rows,
  savingOrder,
  selectSort,
  setSort,
  sortKey,
  sortDirection,
  sortMark,
  statusFilter,
  summary,
  toggleSortDirection,
} = useServerList(() => props.nodes)

const desktopOrderContainer = ref<HTMLElement | null>(null)
const mobileOrderContainer = ref<HTMLElement | null>(null)
const orderAnnouncement = ref('')
useSortableOrder(
  [desktopOrderContainer, mobileOrderContainer],
  () => editingOrder.value && rows.value.length > 1,
  moveOrderWithFeedback,
)

const statusOptions = computed<Array<{ key: ServerListStatusFilter, label: string, count: number }>>(() => [
  { key: 'all', label: '全部', count: summary.value.total },
  { key: 'online', label: '在线', count: summary.value.online },
  { key: 'offline', label: '离线', count: summary.value.offline },
  { key: 'maintenance', label: '维护', count: summary.value.maintenance },
])

const mobileSortOptions: Array<{ key: ServerListSortKey, label: string }> = [
  { key: 'official', label: '官方顺序' },
  { key: 'status', label: '状态' },
  { key: 'name', label: '名称' },
  { key: 'cpu', label: 'CPU' },
  { key: 'traffic', label: '流量' },
  { key: 'updated', label: '更新时间' },
]

function isMaintenanceNode(node: NodeData): boolean {
  return Boolean(appStore.pandaOpsNodeControls[node.uuid]?.maintenanceUntil)
}

function getNodeStatus(node: NodeData): { label: string, class: string, dot: string } {
  if (isMaintenanceNode(node)) {
    return {
      label: '维护',
      class: 'border-warning/30 bg-warning/10 text-warning',
      dot: 'bg-warning',
    }
  }
  if (node.online) {
    return {
      label: '在线',
      class: 'border-success/30 bg-success/10 text-success',
      dot: 'bg-success',
    }
  }
  return {
    label: '离线',
    class: 'border-destructive/30 bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  }
}

function getMemoryPercentage(node: NodeData): number {
  return node.mem_total > 0 ? Math.min(100, Math.max(0, node.ram / node.mem_total * 100)) : 0
}

function formatBytes(value: number): string {
  return formatBytesWithConfig(value || 0, appStore.byteDecimals)
}

function formatSpeed(value: number): string {
  return formatBytesPerSecondWithConfig(value || 0, appStore.byteDecimals)
}

function formatUpdatedAt(node: NodeData): string {
  const value = node.status_updated_at || node.time || node.updated_at
  return value ? formatDateTime(value) : '-'
}

function formatRegion(node: NodeData): string {
  return getRegionDisplayName(node.region) || node.region || '-'
}

function setSortFromSelect(event: Event): void {
  const key = (event.target as HTMLSelectElement).value as ServerListSortKey
  selectSort(key)
}

function startOrderEdit(): void {
  if (!props.canEditOrder) {
    window.$message?.warning('请先切换到“全部节点”再编辑首页顺序。')
    return
  }
  orderAnnouncement.value = ''
  beginOrderEdit()
}

function announceOrderMove(node: NodeData, toIndex: number): void {
  orderAnnouncement.value = `${node.name} 已移动到第 ${toIndex + 1} 位，共 ${rows.value.length} 位。`
}

function moveOrderWithFeedback(fromIndex: number, toIndex: number): void {
  const node = rows.value[fromIndex]
  if (!node || fromIndex === toIndex)
    return
  moveOrderToIndex(fromIndex, toIndex)
  announceOrderMove(node, toIndex)
}

function handleOrderKeydown(event: KeyboardEvent, node: NodeData): void {
  const fromIndex = rows.value.findIndex(row => row.uuid === node.uuid)
  if (fromIndex < 0)
    return

  let toIndex = fromIndex
  if (event.key === 'ArrowUp')
    toIndex = fromIndex - 1
  else if (event.key === 'ArrowDown')
    toIndex = fromIndex + 1
  else if (event.key === 'Home')
    toIndex = 0
  else if (event.key === 'End')
    toIndex = rows.value.length - 1
  else
    return

  event.preventDefault()
  if (toIndex < 0 || toIndex >= rows.value.length || toIndex === fromIndex)
    return
  moveOrderToIndex(fromIndex, toIndex)
  announceOrderMove(node, toIndex)
}

async function saveOrder(): Promise<void> {
  const granted = await appStore.requireLoginPermission('serverList', { force: true })
  if (!granted) {
    window.$message?.warning('登录状态已过期，请重新登录后保存。')
    return
  }

  try {
    await persistOrder()
    window.$message?.success('首页服务器顺序已保存。')
  }
  catch (error) {
    window.$message?.error(`保存服务器顺序失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
</script>

<template>
  <section data-server-list-panel class="space-y-3" aria-labelledby="server-list-title">
    <div class="flex flex-col gap-3 border-b border-border/60 pb-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <h2 id="server-list-title" class="text-base font-semibold">
          服务器列表
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ summary.total }} 台服务器 · {{ summary.online }} 在线 · {{ summary.offline }} 离线
        </p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2 self-start sm:self-auto">
        <Button v-if="!editingOrder" variant="outline" size="sm" :title="canEditOrder ? '编辑首页顺序' : '请先切换到全部节点'" @click="startOrderEdit">
          <Icon icon="tabler:arrows-move-vertical" />
          编辑首页顺序
        </Button>
        <Button as="a" href="/admin/servers" target="_blank" rel="noopener" variant="outline" size="sm">
          <Icon icon="tabler:settings" />
          官方后台
        </Button>
      </div>
    </div>

    <div v-if="editingOrder" class="flex flex-col gap-2 border-b border-border/60 pb-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-xs text-muted-foreground">
        首页与官方后台共用此全局顺序。
      </p>
      <div class="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" :disabled="savingOrder" @click="cancelOrderEdit">
          取消
        </Button>
        <Button size="sm" :disabled="savingOrder || !orderDirty" @click="saveOrder">
          <Icon :icon="savingOrder ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="savingOrder && 'animate-spin'" />
          保存顺序
        </Button>
      </div>
      <p id="server-order-instructions" class="sr-only">
        使用拖动抓手调整顺序；键盘用户可用上下方向键逐项移动，或用 Home 和 End 移到首尾。
      </p>
      <p class="sr-only" aria-live="polite">
        {{ orderAnnouncement }}
      </p>
    </div>

    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60 sm:grid-cols-4">
      <div
        v-for="option in statusOptions"
        :key="option.key"
        class="flex min-h-14 items-center justify-between gap-2 bg-background/85 px-3 py-2"
      >
        <span class="text-xs text-muted-foreground">{{ option.label }}</span>
        <strong class="text-lg font-semibold tabular-nums">{{ option.count }}</strong>
      </div>
    </div>

    <div class="flex flex-col gap-2 lg:flex-row lg:items-center">
      <div class="relative min-w-0 flex-1">
        <Icon icon="tabler:search" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" width="15" height="15" />
        <Input
          v-model="query"
          :disabled="editingOrder"
          aria-label="搜索服务器"
          placeholder="搜索名称、地区、IP、系统、CPU"
          class="h-8 pl-8 shadow-none"
        />
      </div>
      <div class="flex min-w-0 items-center gap-1 overflow-x-auto rounded-md bg-muted/55 p-1">
        <button
          v-for="option in statusOptions"
          :key="option.key"
          type="button"
          :disabled="editingOrder"
          class="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          :class="statusFilter === option.key && 'bg-background text-foreground shadow-xs'"
          :aria-pressed="statusFilter === option.key"
          @click="statusFilter = option.key"
        >
          {{ option.label }}
          <span class="tabular-nums text-[10px] opacity-70">{{ option.count }}</span>
        </button>
      </div>
      <label class="flex h-8 min-w-36 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs">
        <Icon icon="tabler:arrows-sort" class="text-muted-foreground" width="14" height="14" />
        <span class="sr-only">排序方式</span>
        <select :value="sortKey" :disabled="editingOrder" class="min-w-0 flex-1 bg-transparent outline-none" aria-label="排序方式" @change="setSortFromSelect">
          <option v-for="option in mobileSortOptions" :key="option.key" :value="option.key">
            {{ option.label }}
          </option>
        </select>
      </label>
      <Button
        variant="outline"
        size="icon-sm"
        :disabled="editingOrder"
        :aria-label="sortDirection === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'"
        :title="sortDirection === 'asc' ? '升序' : '降序'"
        @click="toggleSortDirection"
      >
        <Icon :icon="sortDirection === 'asc' ? 'tabler:sort-ascending' : 'tabler:sort-descending'" />
      </Button>
    </div>

    <div v-if="rows.length" class="hidden overflow-x-auto rounded-md border border-border/60 md:block">
      <table class="w-full min-w-[1080px] table-fixed text-left text-xs">
        <thead class="bg-muted/45 text-muted-foreground">
          <tr>
            <th class="w-24 px-3 py-2.5 font-medium">
              <button type="button" :disabled="editingOrder" @click="setSort('status')">
                状态{{ sortMark('status') }}
              </button>
            </th>
            <th class="w-52 px-3 py-2.5 font-medium">
              <button type="button" :disabled="editingOrder" @click="setSort('name')">
                服务器{{ sortMark('name') }}
              </button>
            </th>
            <th class="w-40 px-3 py-2.5 font-medium">
              位置 / 分组
            </th>
            <th class="w-48 px-3 py-2.5 font-medium">
              系统
            </th>
            <th class="w-32 px-3 py-2.5 font-medium">
              <button type="button" :disabled="editingOrder" @click="setSort('cpu')">
                CPU{{ sortMark('cpu') }}
              </button>
            </th>
            <th class="w-36 px-3 py-2.5 font-medium">
              内存
            </th>
            <th class="w-40 px-3 py-2.5 font-medium">
              <button type="button" :disabled="editingOrder" @click="setSort('traffic')">
                实时流量{{ sortMark('traffic') }}
              </button>
            </th>
            <th class="w-40 px-3 py-2.5 font-medium">
              <button type="button" :disabled="editingOrder" @click="setSort('updated')">
                更新时间{{ sortMark('updated') }}
              </button>
            </th>
            <th class="w-24 px-3 py-2.5 text-right font-medium">
              操作
            </th>
          </tr>
        </thead>
        <tbody ref="desktopOrderContainer" class="divide-y divide-border/50">
          <tr
            v-for="(node, index) in rows"
            :key="node.uuid"
            :data-server-order-item="editingOrder ? node.uuid : undefined"
            class="bg-background/25 transition-[background-color,opacity,box-shadow] hover:bg-background/60"
            :class="editingOrder && 'select-none'"
          >
            <td class="px-3 py-3">
              <Badge variant="outline" class="gap-1 rounded-md px-1.5 text-[11px]" :class="getNodeStatus(node).class">
                <span class="size-1.5 rounded-full" :class="getNodeStatus(node).dot" />
                {{ getNodeStatus(node).label }}
              </Badge>
            </td>
            <td class="px-3 py-3">
              <button type="button" class="block max-w-full text-left" @click="emit('openNode', node)">
                <span class="block truncate font-semibold text-foreground">{{ node.name }}</span>
                <span class="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{{ node.ipv4 || node.ipv6 || node.uuid }}</span>
              </button>
            </td>
            <td class="px-3 py-3">
              <span class="block truncate text-foreground/80">{{ formatRegion(node) }}</span>
              <span class="mt-0.5 block truncate text-[10px] text-muted-foreground">{{ node.groups.join(' · ') || '未分组' }}</span>
            </td>
            <td class="px-3 py-3">
              <span class="block truncate text-foreground/80">{{ node.os || '-' }}</span>
              <span class="mt-0.5 block truncate text-[10px] text-muted-foreground">{{ node.arch || '-' }} · {{ node.virtualization || '-' }} · {{ node.version || '-' }}</span>
            </td>
            <td class="px-3 py-3">
              <div class="mb-1 flex justify-between tabular-nums">
                <span>{{ (node.cpu || 0).toFixed(1) }}%</span><span class="text-muted-foreground">{{ node.cpu_cores || 0 }} 核</span>
              </div>
              <ProgressThin :percentage="node.cpu || 0" :status="getStatus(node.cpu || 0)" :height="4" />
            </td>
            <td class="px-3 py-3">
              <div class="mb-1 flex justify-between tabular-nums">
                <span>{{ getMemoryPercentage(node).toFixed(1) }}%</span><span class="text-muted-foreground">{{ formatBytes(node.mem_total) }}</span>
              </div>
              <ProgressThin :percentage="getMemoryPercentage(node)" :status="getStatus(getMemoryPercentage(node))" :height="4" />
            </td>
            <td class="px-3 py-3 tabular-nums">
              <span class="block text-success">↑ {{ formatSpeed(node.net_out) }}</span>
              <span class="mt-0.5 block text-blue-600 dark:text-blue-400">↓ {{ formatSpeed(node.net_in) }}</span>
            </td>
            <td class="px-3 py-3 text-[11px] text-muted-foreground">
              {{ formatUpdatedAt(node) }}
            </td>
            <td class="px-3 py-3">
              <div class="flex justify-end gap-1">
                <template v-if="editingOrder">
                  <Button
                    data-order-drag-handle
                    variant="ghost"
                    size="icon-sm"
                    class="cursor-grab touch-none active:cursor-grabbing"
                    :aria-label="`拖动 ${node.name}，当前第 ${index + 1} 位，共 ${rows.length} 位`"
                    aria-describedby="server-order-instructions"
                    :title="`拖动 ${node.name}`"
                    @keydown="handleOrderKeydown($event, node)"
                  >
                    <Icon icon="tabler:grip-vertical" />
                  </Button>
                </template>
                <template v-else>
                  <Button variant="ghost" size="icon-xs" :aria-label="`查看 ${node.name} 详情`" :title="`查看 ${node.name} 详情`" @click="emit('openNode', node)">
                    <Icon icon="tabler:external-link" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" :aria-label="`运维 ${node.name}`" :title="`运维 ${node.name}`" @click="emit('manageNode', node)">
                    <Icon icon="tabler:adjustments-horizontal" />
                  </Button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="rows.length" ref="mobileOrderContainer" class="space-y-2 md:hidden">
      <article
        v-for="(node, index) in rows"
        :key="node.uuid"
        :data-server-order-item="editingOrder ? node.uuid : undefined"
        class="rounded-md border border-border/60 bg-background/35 p-3 transition-[background-color,opacity,box-shadow]"
        :class="editingOrder && 'select-none'"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <h3 class="truncate text-sm font-semibold">
                {{ node.name }}
              </h3>
              <Badge variant="outline" class="shrink-0 gap-1 rounded-md px-1.5 text-[10px]" :class="getNodeStatus(node).class">
                <span class="size-1.5 rounded-full" :class="getNodeStatus(node).dot" />
                {{ getNodeStatus(node).label }}
              </Badge>
            </div>
            <p class="mt-1 truncate font-mono text-[10px] text-muted-foreground">
              {{ node.ipv4 || node.ipv6 || node.uuid }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <template v-if="editingOrder">
              <Button
                data-order-drag-handle
                variant="ghost"
                size="icon-sm"
                class="cursor-grab touch-none active:cursor-grabbing"
                :aria-label="`拖动 ${node.name}，当前第 ${index + 1} 位，共 ${rows.length} 位`"
                aria-describedby="server-order-instructions"
                :title="`拖动 ${node.name}`"
                @keydown="handleOrderKeydown($event, node)"
              >
                <Icon icon="tabler:grip-vertical" />
              </Button>
            </template>
            <template v-else>
              <Button variant="ghost" size="icon-xs" :aria-label="`查看 ${node.name} 详情`" @click="emit('openNode', node)">
                <Icon icon="tabler:external-link" />
              </Button>
              <Button variant="ghost" size="icon-xs" :aria-label="`运维 ${node.name}`" @click="emit('manageNode', node)">
                <Icon icon="tabler:adjustments-horizontal" />
              </Button>
            </template>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/50 pt-2 text-[11px]">
          <div class="min-w-0">
            <span class="text-muted-foreground">位置</span><strong class="ml-1 truncate font-medium">{{ formatRegion(node) }}</strong>
          </div>
          <div class="min-w-0">
            <span class="text-muted-foreground">系统</span><strong class="ml-1 truncate font-medium">{{ node.os || '-' }}</strong>
          </div>
          <div><span class="text-muted-foreground">CPU</span><strong class="ml-1 font-medium tabular-nums">{{ (node.cpu || 0).toFixed(1) }}%</strong></div>
          <div><span class="text-muted-foreground">内存</span><strong class="ml-1 font-medium tabular-nums">{{ getMemoryPercentage(node).toFixed(1) }}%</strong></div>
          <div><span class="text-muted-foreground">上行</span><strong class="ml-1 font-medium tabular-nums text-success">{{ formatSpeed(node.net_out) }}</strong></div>
          <div><span class="text-muted-foreground">下行</span><strong class="ml-1 font-medium tabular-nums text-blue-600 dark:text-blue-400">{{ formatSpeed(node.net_in) }}</strong></div>
        </div>
      </article>
    </div>

    <Empty v-if="!rows.length" :description="query.trim() ? '没有匹配的服务器' : '当前筛选下暂无服务器'" class="py-10" />
  </section>
</template>

<style scoped>
:global(.server-order-ghost) {
  opacity: 0.28;
}

:global(.server-order-chosen) {
  background-color: color-mix(in srgb, var(--primary) 9%, var(--background));
}

:global(.server-order-drag) {
  box-shadow: 0 12px 28px rgb(15 23 42 / 0.2);
}
</style>
