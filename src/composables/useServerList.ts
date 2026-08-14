import type { MaybeRefOrGetter } from 'vue'
import type {
  ServerListSortKey,
  ServerListStatusFilter,
} from '@/services/server-list.service'
import type { NodeData } from '@/stores/nodes'
import { computed, ref, toValue } from 'vue'
import {
  filterAndSortServerList,
  reconcileServerOrder,
  saveServerOrder,
  sortServersByOfficialOrder,
  summarizeServerList,
} from '@/services/server-list.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'

export function useServerList(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const nodesStore = useNodesStore()
  const query = ref('')
  const statusFilter = ref<ServerListStatusFilter>('all')
  const sortKey = ref<ServerListSortKey>('official')
  const sortDirection = ref<'asc' | 'desc'>('asc')
  const editingOrder = ref(false)
  const savingOrder = ref(false)
  const orderDraft = ref<string[]>([])
  let viewBeforeOrderEdit: {
    query: string
    sortDirection: 'asc' | 'desc'
    sortKey: ServerListSortKey
    statusFilter: ServerListStatusFilter
  } | null = null

  const maintenanceIds = computed(() => new Set(
    Object.entries(appStore.pandaOpsNodeControls)
      .filter(([, control]) => Boolean(control.maintenanceUntil))
      .map(([uuid]) => uuid),
  ))

  const summary = computed(() => summarizeServerList(toValue(nodes), maintenanceIds.value))

  const reconciledOrderDraft = computed(() => reconcileServerOrder(orderDraft.value, toValue(nodes)))

  const rows = computed(() => {
    const currentNodes = toValue(nodes)
    if (editingOrder.value) {
      const nodesByUuid = new Map(currentNodes.map(node => [node.uuid, node]))
      return reconciledOrderDraft.value
        .map(uuid => nodesByUuid.get(uuid))
        .filter((node): node is NodeData => Boolean(node))
    }

    return filterAndSortServerList(currentNodes, {
      query: query.value,
      status: statusFilter.value,
      maintenanceIds: maintenanceIds.value,
      sortKey: sortKey.value,
      sortDirection: sortDirection.value,
    })
  })

  const orderDirty = computed(() => {
    if (!editingOrder.value)
      return false
    const currentOrder = sortServersByOfficialOrder(toValue(nodes)).map(node => node.uuid)
    const draft = reconciledOrderDraft.value
    return currentOrder.length !== draft.length || currentOrder.some((uuid, index) => draft[index] !== uuid)
  })

  function setSort(key: ServerListSortKey): void {
    if (sortKey.value === key) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
      return
    }

    sortKey.value = key
    sortDirection.value = ['cpu', 'traffic', 'updated'].includes(key) ? 'desc' : 'asc'
  }

  function selectSort(key: ServerListSortKey): void {
    if (sortKey.value === key)
      return
    sortKey.value = key
    sortDirection.value = ['cpu', 'traffic', 'updated'].includes(key) ? 'desc' : 'asc'
  }

  function toggleSortDirection(): void {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  }

  function sortMark(key: ServerListSortKey): string {
    if (sortKey.value !== key)
      return ''
    return sortDirection.value === 'asc' ? ' ↑' : ' ↓'
  }

  function beginOrderEdit(): void {
    if (editingOrder.value)
      return

    viewBeforeOrderEdit = {
      query: query.value,
      sortDirection: sortDirection.value,
      sortKey: sortKey.value,
      statusFilter: statusFilter.value,
    }
    query.value = ''
    statusFilter.value = 'all'
    sortKey.value = 'official'
    sortDirection.value = 'asc'
    orderDraft.value = sortServersByOfficialOrder(toValue(nodes)).map(node => node.uuid)
    editingOrder.value = true
  }

  function cancelOrderEdit(): void {
    editingOrder.value = false
    orderDraft.value = []
    if (viewBeforeOrderEdit) {
      query.value = viewBeforeOrderEdit.query
      sortDirection.value = viewBeforeOrderEdit.sortDirection
      sortKey.value = viewBeforeOrderEdit.sortKey
      statusFilter.value = viewBeforeOrderEdit.statusFilter
      viewBeforeOrderEdit = null
    }
  }

  function completeOrderEdit(): void {
    editingOrder.value = false
    orderDraft.value = []
    viewBeforeOrderEdit = null
  }

  function moveOrderToIndex(fromIndex: number, toIndex: number): void {
    const currentOrder = reconciledOrderDraft.value
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= currentOrder.length || toIndex >= currentOrder.length || fromIndex === toIndex)
      return

    const nextOrder = [...currentOrder]
    const [nodeUuid] = nextOrder.splice(fromIndex, 1)
    if (!nodeUuid)
      return
    nextOrder.splice(toIndex, 0, nodeUuid)
    orderDraft.value = nextOrder
  }

  async function persistOrder(): Promise<void> {
    if (!editingOrder.value || savingOrder.value)
      return
    savingOrder.value = true
    try {
      const order = reconciledOrderDraft.value
      await saveServerOrder(order)
      nodesStore.applyNodeOrder(order)
      completeOrderEdit()
    }
    finally {
      savingOrder.value = false
    }
  }

  return {
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
    sortDirection,
    sortKey,
    sortMark,
    setSort,
    statusFilter,
    summary,
    toggleSortDirection,
  }
}
