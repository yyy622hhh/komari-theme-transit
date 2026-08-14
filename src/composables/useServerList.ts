import type { MaybeRefOrGetter } from 'vue'
import type {
  ServerListSortKey,
  ServerListStatusFilter,
} from '@/services/server-list.service'
import type { NodeData } from '@/stores/nodes'
import { computed, ref, toValue } from 'vue'
import {
  filterAndSortServerList,
  summarizeServerList,
} from '@/services/server-list.service'
import { useAppStore } from '@/stores/app'

export function useServerList(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const query = ref('')
  const statusFilter = ref<ServerListStatusFilter>('all')
  const sortKey = ref<ServerListSortKey>('status')
  const sortDirection = ref<'asc' | 'desc'>('asc')

  const maintenanceIds = computed(() => new Set(
    Object.entries(appStore.pandaOpsNodeControls)
      .filter(([, control]) => Boolean(control.maintenanceUntil))
      .map(([uuid]) => uuid),
  ))

  const summary = computed(() => summarizeServerList(toValue(nodes), maintenanceIds.value))

  const rows = computed(() => filterAndSortServerList(toValue(nodes), {
    query: query.value,
    status: statusFilter.value,
    maintenanceIds: maintenanceIds.value,
    sortKey: sortKey.value,
    sortDirection: sortDirection.value,
  }))

  function setSort(key: ServerListSortKey): void {
    if (sortKey.value === key) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
      return
    }

    sortKey.value = key
    sortDirection.value = ['cpu', 'traffic', 'updated'].includes(key) ? 'desc' : 'asc'
  }

  function sortMark(key: ServerListSortKey): string {
    if (sortKey.value !== key)
      return ''
    return sortDirection.value === 'asc' ? ' ↑' : ' ↓'
  }

  return {
    query,
    rows,
    sortDirection,
    sortKey,
    sortMark,
    setSort,
    statusFilter,
    summary,
  }
}
