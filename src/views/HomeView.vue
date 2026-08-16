<script setup lang="ts">
import type { PermissionKey } from '@/services/auth.service'
import type { HomeQuickControlKey } from '@/stores/app'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DeferredRender from '@/components/DeferredRender.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useOrderMoveFeedback } from '@/composables/useOrderMoveFeedback'
import { useServerList } from '@/composables/useServerList'
import { useSortableOrder } from '@/composables/useSortableOrder'
import { useVisitorAudit } from '@/composables/useVisitorAudit'
import { UI_CONFIG } from '@/constants/ui'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import {
  getRealtimePeakSpeed,
  getTotalTraffic,
  isExpiringNode,
  isHighLoadNode,
} from '@/utils/nodeMetricsHelper'
import { isNodeMatchSearch } from '@/utils/nodeSearch'

interface QuickControlOption {
  key: HomeQuickControlKey
  label: string
  icon: string
}

type HomeToolKey = 'nodes' | 'nodeCompare' | 'serverList' | 'topology' | 'providerValue' | 'healthSummary' | 'snapshotExport' | 'auditLog'
type PrivateHomeToolKey = Exclude<HomeToolKey, 'nodes' | 'nodeCompare'>

interface HomeToolOption {
  key: Exclude<HomeToolKey, 'nodes'>
  label: string
  icon: string
  description: string
}

defineOptions({ name: 'HomeView' })

const AuditLogPanel = defineAsyncComponent(() => import('@/components/AuditLogPanel.vue'))
const HealthSummaryPanel = defineAsyncComponent(() => import('@/components/HealthSummaryPanel.vue'))
const NodeCard = defineAsyncComponent(() => import('@/components/NodeCard.vue'))
const NodeGeneralCards = defineAsyncComponent(() => import('@/components/NodeGeneralCards.vue'))
const NodeList = defineAsyncComponent(() => import('@/components/NodeList.vue'))
const NodeComparePanel = defineAsyncComponent(() => import('@/components/NodeComparePanel.vue'))
const PandaOpsDashboard = defineAsyncComponent(() => import('@/components/PandaOpsDashboard.vue'))
const PandaOpsNodeControlDialog = defineAsyncComponent(() => import('@/components/PandaOpsNodeControlDialog.vue'))
const PandaOpsNodeCard = defineAsyncComponent(() => import('@/components/PandaOpsNodeCard.vue'))
const PingMonitorDialog = defineAsyncComponent(() => import('@/components/PingMonitorDialog.vue'))
const NodeTopologyPanel = defineAsyncComponent(() => import('@/components/NodeTopologyPanel.vue'))
const ProviderValuePanel = defineAsyncComponent(() => import('@/components/ProviderValuePanel.vue'))
const SnapshotExportPanel = defineAsyncComponent(() => import('@/components/SnapshotExportPanel.vue'))
const ServerListPanel = defineAsyncComponent(() => import('@/components/ServerListPanel.vue'))

const nodeItemStaggerMs = UI_CONFIG.motion.staggerMs
const nodeItemStaggerLimit = UI_CONFIG.motion.staggerLimit
const denseNodeAppearThreshold = UI_CONFIG.motion.denseNodeAppearThreshold
const denseNodePingAnimationThreshold = UI_CONFIG.motion.denseNodePingAnimationThreshold

const appStore = useAppStore()
const nodesStore = useNodesStore()
const router = useRouter()
const { record: recordVisitorEvent } = useVisitorAudit()
const isViewActive = ref(true)

onActivated(() => {
  isViewActive.value = true
  nextTick(() => {
    if (appStore.homeScrollPosition > 0)
      window.scrollTo({ top: appStore.homeScrollPosition, behavior: 'instant' })
  })
})

onDeactivated(() => {
  isViewActive.value = false
  appStore.homeScrollPosition = window.scrollY
})

const searchText = ref('')
const debouncedSearchText = ref('')
const activeHomeTool = ref<HomeToolKey>('nodes')
const activeQuickControl = ref<HomeQuickControlKey | null>(null)
const pingDialogNode = ref<NodeData | null>(null)
const nodeControlDialogNode = ref<NodeData | null>(null)
const homeOrderContainer = ref<HTMLElement | null>(null)
const homeOrderViewBeforeEdit = ref<{
  group: string
  search: string
  debouncedSearch: string
  quickControl: HomeQuickControlKey | null
} | null>(null)

const homeOrder = useServerList(() => nodesStore.visibleNodes)
const {
  announcement: homeOrderAnnouncement,
  handleKeydown: handleHomeOrderKeydown,
  moveWithFeedback: moveHomeOrderWithFeedback,
  resetAnnouncement: resetHomeOrderAnnouncement,
} = useOrderMoveFeedback({
  items: () => homeOrder.rows.value,
  getId: node => node.uuid,
  getLabel: node => node.name,
  move: homeOrder.moveOrderToIndex,
})

const homeToolPermissionMap: Record<PrivateHomeToolKey, PermissionKey> = {
  serverList: 'serverList',
  topology: 'nodeTopology',
  providerValue: 'providerValue',
  healthSummary: 'healthSummary',
  snapshotExport: 'snapshotExport',
  auditLog: 'auditLog',
}

const quickControlDefinitions: Record<HomeQuickControlKey, QuickControlOption> = {
  favorite: { key: 'favorite', label: '收藏', icon: 'tabler:star' },
  monthlyCost: { key: 'monthlyCost', label: '月成本', icon: 'tabler:calendar-dollar' },
  totalTraffic: { key: 'totalTraffic', label: '总流量', icon: 'tabler:database' },
  upload: { key: 'upload', label: '上行', icon: 'tabler:chevron-up' },
  download: { key: 'download', label: '下行', icon: 'tabler:chevron-down' },
  peak: { key: 'peak', label: '峰值', icon: 'tabler:activity' },
  offline: { key: 'offline', label: '离线', icon: 'tabler:plug-connected-x' },
  highLoad: { key: 'highLoad', label: '高负载', icon: 'tabler:alert-triangle' },
  expiring: { key: 'expiring', label: '即将到期', icon: 'tabler:calendar-exclamation' },
}

const homeTools = computed<HomeToolOption[]>(() => {
  if (!appStore.homeToolsEnabled)
    return []

  const tools: HomeToolOption[] = [
    { key: 'nodeCompare', label: '对比', icon: 'tabler:columns-3', description: '最多四台节点实时横向对比' },
  ]
  if (!appStore.privateFeaturesAllowed)
    return tools

  return [...tools, { key: 'serverList', label: '服务器', icon: 'tabler:server-2', description: '实时服务器清单与运维入口' }, { key: 'topology', label: '网络', icon: 'tabler:route', description: '网络归属、配置链路与离线聚类' }, { key: 'providerValue', label: '性价比', icon: 'tabler:scale', description: '单机资源成本对比' }, { key: 'healthSummary', label: '健康', icon: 'tabler:heartbeat', description: '日周月历史健康概览' }, { key: 'snapshotExport', label: '导出', icon: 'tabler:download', description: 'CSV / JSON 数据快照' }, { key: 'auditLog', label: '日志', icon: 'tabler:list-details', description: '管理员操作审计日志' }]
})

const updateDebouncedSearch = useDebounceFn((value: string) => {
  debouncedSearchText.value = value
}, 300)

watch(searchText, (value) => {
  updateDebouncedSearch(value)
})

const groups = computed(() => [
  { tab: '全部节点', name: 'all' },
  ...nodesStore.groups.map(g => ({ tab: g, name: g })),
])

const quickControlKeys = computed<HomeQuickControlKey[]>(() => appStore.homeQuickControlOrder.filter(key => key !== 'monthlyCost'))
const quickControls = computed(() => quickControlKeys.value.map(key => quickControlDefinitions[key]))
const showQuickControls = computed(() => appStore.homeQuickControlsEnabled && quickControls.value.length > 0)

watch(
  () => [appStore.homeQuickControlOrder.join('|'), appStore.homeQuickControlsEnabled] as const,
  () => {
    if (!appStore.homeQuickControlsEnabled) {
      activeQuickControl.value = null
      return
    }

    if (activeQuickControl.value && !quickControlKeys.value.includes(activeQuickControl.value))
      activeQuickControl.value = null
  },
  { immediate: true },
)

watch(
  () => nodesStore.groups,
  (gs) => {
    const cur = appStore.nodeSelectedGroup
    if (cur !== 'all' && !gs.includes(cur)) {
      appStore.nodeSelectedGroup = 'all'
    }
  },
  { immediate: true },
)

function sortNodesByComputedValue(nodes: NodeData[], selector: (node: NodeData) => number): NodeData[] {
  return nodes
    .map(node => ({ node, value: selector(node) }))
    .sort((a, b) => b.value - a.value)
    .map(item => item.node)
}

function placeOfflineNodesLast(nodes: NodeData[]): NodeData[] {
  if (!appStore.offlineNodesLast)
    return nodes

  return [...nodes].sort((a, b) => {
    if (a.online === b.online)
      return 0
    return a.online ? -1 : 1
  })
}

function isNodeInMaintenance(node: NodeData): boolean {
  return Boolean(appStore.pandaOpsNodeControls[node.uuid]?.maintenanceUntil)
}

function getQuickControlNodes(nodes: NodeData[], control: HomeQuickControlKey | null): NodeData[] {
  let result: NodeData[]

  switch (control) {
    case 'favorite':
      return nodes.filter(node => appStore.isFavoriteNode(node.uuid))
    case 'totalTraffic':
      result = sortNodesByComputedValue(nodes, getTotalTraffic)
      break
    case 'upload':
      result = [...nodes].sort((a, b) => (b.net_out || 0) - (a.net_out || 0))
      break
    case 'download':
      result = [...nodes].sort((a, b) => (b.net_in || 0) - (a.net_in || 0))
      break
    case 'peak':
      result = sortNodesByComputedValue(nodes, getRealtimePeakSpeed)
      break
    case 'offline':
      return nodes.filter(node => !node.online && !isNodeInMaintenance(node))
    case 'highLoad':
      result = nodes.filter(node => isHighLoadNode(node, appStore.homeHighLoadThreshold))
      break
    case 'expiring':
      result = nodes.filter(node => isExpiringNode(node, appStore.homeExpiringDays))
      break
    default:
      result = nodes
      break
  }

  return placeOfflineNodesLast(result)
}

function getQuickControlCount(nodes: NodeData[], control: HomeQuickControlKey): number {
  switch (control) {
    case 'favorite':
      return nodes.reduce((count, node) => count + (appStore.isFavoriteNode(node.uuid) ? 1 : 0), 0)
    case 'offline':
      return nodes.reduce((count, node) => count + (!node.online && !isNodeInMaintenance(node) ? 1 : 0), 0)
    case 'highLoad':
      return nodes.reduce((count, node) => count + (isHighLoadNode(node, appStore.homeHighLoadThreshold) ? 1 : 0), 0)
    case 'expiring':
      return nodes.reduce((count, node) => count + (isExpiringNode(node, appStore.homeExpiringDays) ? 1 : 0), 0)
    default:
      return nodes.length
  }
}

const groupNodeList = computed(() => {
  const selectedGroup = appStore.nodeSelectedGroup
  if (selectedGroup === 'all')
    return nodesStore.visibleNodes
  return nodesStore.visibleNodes.filter(node => node.groups.includes(selectedGroup))
})

const nodeList = computed(() => {
  let filtered = groupNodeList.value
  if (debouncedSearchText.value.trim()) {
    filtered = filtered.filter(n => isNodeMatchSearch(n, debouncedSearchText.value))
  }
  return getQuickControlNodes(filtered, activeQuickControl.value)
})

const displayedNodeList = computed(() => homeOrder.editingOrder.value ? homeOrder.rows.value : nodeList.value)

const isDenseNodeGrid = computed(() => appStore.nodeViewMode === 'card' && displayedNodeList.value.length > denseNodeAppearThreshold)
const enableNodeCardTransition = computed(() => !appStore.disablePageAnimation && !isDenseNodeGrid.value)
const reduceDenseNodeEffects = computed(() => appStore.nodeViewMode === 'card' && displayedNodeList.value.length > denseNodePingAnimationThreshold)
const deferNodeCards = computed(() => !homeOrder.editingOrder.value && appStore.nodeViewMode === 'card' && displayedNodeList.value.length > UI_CONFIG.virtualList.nodeThreshold)
const deferredNodeCardHeight = computed(() => ({ mini: 300, compact: 320, comfortable: 330, large: 350 }[appStore.nodeCardSize]))

const quickControlCounts = computed<Record<HomeQuickControlKey, number>>(() => {
  let base = groupNodeList.value
  if (debouncedSearchText.value.trim())
    base = base.filter(n => isNodeMatchSearch(n, debouncedSearchText.value))

  const counts = {} as Record<HomeQuickControlKey, number>
  for (const key of quickControlKeys.value)
    counts[key] = getQuickControlCount(base, key)
  return counts
})

const emptyDescription = computed(() => {
  if (debouncedSearchText.value.trim())
    return '没有匹配的节点'
  if (activeQuickControl.value)
    return '当前快捷筛选下暂无节点'
  return '暂无节点'
})

function clearSearch() {
  searchText.value = ''
  debouncedSearchText.value = ''
}

const nodeListSortResetKey = computed(() => {
  return `${appStore.nodeSelectedGroup}|${debouncedSearchText.value.trim()}|${activeQuickControl.value ?? 'all'}`
})

function setHomeOrderContainer(value: unknown): void {
  if (typeof HTMLElement === 'undefined') {
    homeOrderContainer.value = null
    return
  }

  if (value instanceof HTMLElement) {
    homeOrderContainer.value = value
    return
  }

  if (value && typeof value === 'object' && '$el' in value) {
    const element = (value as { $el?: unknown }).$el
    homeOrderContainer.value = element instanceof HTMLElement ? element : null
    return
  }

  homeOrderContainer.value = null
}

useSortableOrder(
  [homeOrderContainer],
  () => homeOrder.editingOrder.value && appStore.nodeViewMode === 'card' && displayedNodeList.value.length > 1,
  moveHomeOrderWithFeedback,
)

async function startHomeOrderEdit(): Promise<void> {
  if (homeOrder.editingOrder.value)
    return
  const granted = await appStore.requireLoginPermission('serverList', { force: true })
  if (!granted) {
    window.$message?.warning('登录状态已过期，请重新登录后编辑首页顺序。')
    return
  }
  homeOrderViewBeforeEdit.value = {
    group: appStore.nodeSelectedGroup,
    search: searchText.value,
    debouncedSearch: debouncedSearchText.value,
    quickControl: activeQuickControl.value,
  }
  resetHomeOrderAnnouncement()
  appStore.nodeSelectedGroup = 'all'
  clearSearch()
  activeQuickControl.value = null
  homeOrder.beginOrderEdit()
}

async function focusHomeOrderEditTrigger(): Promise<void> {
  await nextTick()
  const target = document.querySelector<HTMLElement>('[data-home-order-edit-trigger], [aria-label="搜索节点"]')
  target?.focus({ preventScroll: true })
}

function restoreHomeOrderView(): void {
  const previous = homeOrderViewBeforeEdit.value
  homeOrderViewBeforeEdit.value = null
  if (!previous)
    return
  appStore.nodeSelectedGroup = previous.group
  searchText.value = previous.search
  debouncedSearchText.value = previous.debouncedSearch
  activeQuickControl.value = previous.quickControl
}

function cancelHomeOrderEdit(): void {
  homeOrder.cancelOrderEdit()
  restoreHomeOrderView()
  void focusHomeOrderEditTrigger()
}

async function saveHomeOrder(): Promise<void> {
  const granted = await appStore.requireLoginPermission('serverList', { force: true })
  if (!granted) {
    window.$message?.warning('登录状态已过期，请重新登录后保存。')
    return
  }
  try {
    await homeOrder.persistOrder()
    restoreHomeOrderView()
    window.$message?.success('首页服务器顺序已保存。')
    await focusHomeOrderEditTrigger()
  }
  catch (error) {
    window.$message?.error(`保存服务器顺序失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function handleNodeClick(node: NodeData) {
  router.push({ name: 'instance-detail', params: { id: node.uuid } })
}

function openPingDialog(node: NodeData) {
  pingDialogNode.value = node
}

function getNodeItemTransitionKey(node: NodeData): string {
  return `${appStore.nodeSelectedGroup}-${activeQuickControl.value ?? 'all'}-${node.uuid}`
}

function getNodeItemTransitionStyle(index: number): Record<string, string> {
  return {
    '--node-item-delay': `${Math.min(index, nodeItemStaggerLimit) * nodeItemStaggerMs}ms`,
  }
}

function setQuickControl(key: HomeQuickControlKey) {
  activeQuickControl.value = activeQuickControl.value === key ? null : key
  void recordVisitorEvent({
    event: 'filter_change',
    path: '/',
    route: 'home',
    target: activeQuickControl.value ?? 'all',
    detail: { active: Boolean(activeQuickControl.value), result_count: nodeList.value.length },
  })
}

function setNodeViewMode(mode: 'card' | 'list') {
  if (appStore.nodeViewMode === mode)
    return
  appStore.nodeViewMode = mode
  void recordVisitorEvent({
    event: 'view_mode_change',
    path: '/',
    route: 'home',
    target: mode,
  })
}

async function toggleHomeTool(key: Exclude<HomeToolKey, 'nodes'>) {
  if (!homeTools.value.some(tool => tool.key === key))
    return
  if (activeHomeTool.value === key) {
    activeHomeTool.value = 'nodes'
    return
  }

  const permission = key === 'nodeCompare' ? null : homeToolPermissionMap[key]
  if (permission) {
    const granted = await appStore.requireLoginPermission(permission, { force: true })
    if (!granted) {
      activeHomeTool.value = 'nodes'
      window.$message?.warning('登录状态已过期，请重新登录后使用高级工具。')
      return
    }
  }

  activeHomeTool.value = key
  void recordVisitorEvent({
    event: 'home_tool_open',
    path: '/',
    route: 'home',
    target: key,
  })
}

watch(homeTools, (tools) => {
  if (activeHomeTool.value !== 'nodes' && !tools.some(tool => tool.key === activeHomeTool.value))
    activeHomeTool.value = 'nodes'
}, { immediate: true })

watch(() => appStore.homeAdvancedToolsVisible, (visible) => {
  if (!visible)
    activeHomeTool.value = 'nodes'
})

watch(() => appStore.nodeSelectedGroup, (next, previous) => {
  if (next === previous)
    return
  void recordVisitorEvent({
    event: 'group_change',
    path: '/',
    route: 'home',
    target: next,
    detail: { visible_nodes: groupNodeList.value.length },
  })
})

watch(debouncedSearchText, (next, previous) => {
  const keyword = next.trim()
  if (keyword === previous.trim())
    return
  void recordVisitorEvent({
    event: keyword ? 'search' : 'search_clear',
    path: '/',
    route: 'home',
    detail: {
      keyword_length: keyword.length,
      result_count: nodeList.value.length,
    },
  })
})

const activeToolTitle = computed(() => {
  if (activeHomeTool.value === 'nodes')
    return ''
  return homeTools.value.find(tool => tool.key === activeHomeTool.value)?.description ?? ''
})

const nodeCardGridClass = computed(() => {
  if (appStore.opsDashboardEnabled) {
    const pandaOpsSizeClass: Record<typeof appStore.nodeCardSize, string> = {
      mini: 'gap-3 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4',
      compact: 'gap-3 md:grid-cols-2 xl:grid-cols-3',
      comfortable: 'gap-4 lg:grid-cols-2 2xl:grid-cols-3',
      large: 'gap-5 xl:grid-cols-2',
    }
    return ['grid grid-cols-1 md:auto-rows-fr', pandaOpsSizeClass[appStore.nodeCardSize]]
  }

  const sizeClass: Record<typeof appStore.nodeCardSize, string> = {
    mini: 'gap-3 sm:grid-cols-[repeat(auto-fill,minmax(270px,1fr))]',
    compact: 'gap-3 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]',
    comfortable: 'gap-4 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))]',
    large: 'gap-5 sm:grid-cols-[repeat(auto-fill,minmax(420px,1fr))]',
  }
  return ['grid grid-cols-1', sizeClass[appStore.nodeCardSize]]
})
</script>

<template>
  <div class="home-view" :class="!appStore.disablePageAnimation && 'home-view--motion'">
    <div v-if="appStore.alertEnabled && appStore.alertContent" class="alert px-4">
      <Alert class="border-none bg-background/60 backdrop-blur-xs rounded-md">
        <AlertTitle v-if="appStore.alertTitle">
          {{ appStore.alertTitle }}
        </AlertTitle>
        <AlertDescription>
          <MarkdownRenderer :content="appStore.alertContent" />
        </AlertDescription>
      </Alert>
    </div>

    <NodeGeneralCards
      v-if="!appStore.opsDashboardEnabled && !appStore.hideGeneralCard"
      :nodes="groupNodeList"
      :globe-nodes="groupNodeList"
      :transition-key="appStore.nodeSelectedGroup"
      :active="isViewActive"
    />

    <PandaOpsDashboard v-if="appStore.opsDashboardEnabled && isViewActive" :nodes="nodesStore.visibleNodes" />

    <div class="node-info p-3 pt-0 sm:p-4 sm:pt-0 flex flex-col gap-4 relative z-1 pointer-events-none" :class="!appStore.opsDashboardEnabled && !!appStore.hideGeneralCard && 'pt-4'">
      <div class="nodes min-w-0">
        <Tabs v-model="appStore.nodeSelectedGroup" class="w-full flex-col gap-4">
          <div class="flex flex-col gap-2 xl:flex-row xl:items-center">
            <div class="home-controls-scroll min-w-0 overflow-x-auto overscroll-x-contain rounded-sm pointer-events-auto touch-pan-x">
              <div class="flex w-max gap-2">
                <TabsList class="w-max h-8 bg-background/50 backdrop-blur-xl rounded-md pointer-events-auto">
                  <TabsTrigger
                    v-for="g in groups" :key="g.name" :value="g.name"
                    :disabled="homeOrder.editingOrder.value"
                    class="h-6.5 flex-none shrink-0 text-xs border-none data-[state=active]:text-selection shadow-none rounded-sm"
                  >
                    {{ g.tab }}
                  </TabsTrigger>
                </TabsList>

                <div
                  v-if="showQuickControls && activeHomeTool === 'nodes'"
                  class="flex h-8 w-max items-center gap-1 rounded-md bg-background/50 px-1 backdrop-blur-xl pointer-events-auto"
                >
                  <button
                    v-for="control in quickControls" :key="control.key"
                    type="button"
                    :disabled="homeOrder.editingOrder.value"
                    class="inline-flex h-6.5 flex-none shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    :class="activeQuickControl === control.key ? 'bg-background text-selection shadow-sm' : ''"
                    :aria-pressed="activeQuickControl === control.key"
                    :aria-label="`切换到${control.label}节点，${quickControlCounts[control.key] ?? 0} 台`"
                    @click="setQuickControl(control.key)"
                  >
                    <Icon :icon="control.icon" :width="12" :height="12" />
                    <span>{{ control.label }}</span>
                    <span class="rounded-full bg-slate-500/10 px-1 text-[10px] tabular-nums text-foreground/65">
                      {{ quickControlCounts[control.key] ?? 0 }}
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <div class="search flex min-w-0 flex-wrap gap-2 items-center justify-end pointer-events-auto max-sm:justify-start xl:ml-auto">
              <div v-if="homeTools.length && appStore.homeAdvancedToolsVisible" class="flex h-8 items-center gap-1 rounded-md bg-background/50 p-0.5 backdrop-blur-xs">
                <Button
                  v-for="tool in homeTools" :key="tool.key"
                  :disabled="homeOrder.editingOrder.value"
                  variant="ghost" size="icon"
                  class="size-7 rounded-sm text-muted-foreground shadow-none hover:bg-background/60"
                  :class="[activeHomeTool === tool.key ? '!text-selection !bg-background' : '']"
                  :aria-label="`${tool.label}：${tool.description}`"
                  :aria-pressed="activeHomeTool === tool.key"
                  :title="tool.description"
                  @click="toggleHomeTool(tool.key)"
                >
                  <Icon :icon="tool.icon" :width="14" :height="14" />
                </Button>
              </div>

              <Button
                v-if="activeHomeTool === 'nodes' && displayedNodeList.length > 1 && !homeOrder.editingOrder.value"
                data-home-order-edit-trigger
                variant="outline" size="sm"
                class="h-8 border-none bg-background/50 px-2.5 text-xs shadow-none backdrop-blur-xs hover:bg-background/60"
                title="直接拖动首页节点并同步官方后台顺序"
                @click="startHomeOrderEdit"
              >
                <Icon icon="tabler:arrows-move-vertical" :width="14" :height="14" />
                编辑首页顺序
              </Button>

              <Button
                variant="outline" size="icon" aria-label="卡片视图"
                :aria-pressed="appStore.nodeViewMode === 'card'"
                class="w-8 h-8 border-none bg-background/50 backdrop-blur-xs shadow-none hover:bg-background/60 rounded-md"
                :class="[appStore.nodeViewMode === 'card' ? '!text-selection !bg-background' : '']"
                @click="setNodeViewMode('card')"
              >
                <Icon icon="tabler:layout-grid" :width="14" :height="14" />
              </Button>
              <Button
                variant="outline" size="icon" aria-label="列表视图"
                :aria-pressed="appStore.nodeViewMode === 'list'"
                class="w-8 h-8 border-none bg-background/50 backdrop-blur-xs shadow-none hover:bg-background/60 rounded-md"
                :class="[appStore.nodeViewMode === 'list' ? '!text-selection !bg-background' : '']"
                @click="setNodeViewMode('list')"
              >
                <Icon icon="tabler:table" :width="14" :height="14" />
              </Button>
              <div class="relative z-1 h-8" :class="searchText ? 'w-full sm:w-60' : 'w-8'">
                <div class="absolute top-0 right-0 w-full">
                  <Input
                    v-model="searchText" placeholder="搜索名称、地区、IP、CPU"
                    :disabled="homeOrder.editingOrder.value"
                    aria-label="搜索节点"
                    class="transition-all border-none shadow-none h-8 bg-background/50 backdrop-blur-xs rounded-md hover:!bg-background/60 focus:!pl-7.5 focus:placeholder:!text-muted-foreground focus:!bg-background/80 focus:!ring-slate-500/10"
                    :class="searchText ? '!w-full sm:!w-60 !pl-7.5 pr-7 placeholder:!text-muted-foreground' : 'w-8 placeholder:text-transparent focus:!w-52 sm:focus:!w-60'"
                    @keydown.esc.prevent="clearSearch"
                  />
                  <Icon
                    icon="tabler:search" :width="14" :height="14"
                    class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  />
                  <button
                    v-if="searchText"
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="清空搜索"
                    @click="clearSearch"
                  >
                    <Icon icon="tabler:x" :width="14" :height="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div
            v-if="homeOrder.editingOrder.value"
            data-home-order-toolbar
            :aria-busy="homeOrder.savingOrder.value"
            class="pointer-events-auto flex flex-col gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.055] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="min-w-0">
              <p class="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Icon icon="tabler:grip-vertical" :width="15" :height="15" class="text-emerald-600 dark:text-emerald-300" />
                拖动每台服务器右上角的抓手调整首页顺序
              </p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                已自动显示全部节点；保存后会同步官方后台的全局顺序。
              </p>
            </div>
            <div class="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" :disabled="homeOrder.savingOrder.value" @click="cancelHomeOrderEdit">
                取消
              </Button>
              <Button size="sm" :disabled="homeOrder.savingOrder.value || !homeOrder.orderDirty.value" @click="saveHomeOrder">
                <Icon :icon="homeOrder.savingOrder.value ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="homeOrder.savingOrder.value && 'animate-spin'" />
                {{ homeOrder.savingOrder.value ? '保存中' : '保存顺序' }}
              </Button>
            </div>
            <p id="home-order-instructions" class="sr-only">
              使用拖动抓手调整顺序；键盘用户可用上下方向键逐项移动，或用 Home 和 End 移到首尾。
            </p>
            <p class="sr-only" aria-live="polite" aria-atomic="true">
              {{ homeOrderAnnouncement }}
            </p>
          </div>
          <TabsContent v-for="g in groups" :key="g.name" :value="g.name" class="pointer-events-auto">
            <div v-if="activeHomeTool !== 'nodes'" class="mb-4 rounded-lg bg-background/50 px-3 py-2 text-sm text-muted-foreground">
              {{ activeToolTitle }} · 当前分组：{{ g.tab }}（{{ groupNodeList.length }} 台）
            </div>
            <NodeTopologyPanel v-if="activeHomeTool === 'topology'" :nodes="groupNodeList" />
            <NodeComparePanel v-else-if="activeHomeTool === 'nodeCompare'" :nodes="groupNodeList" />
            <ServerListPanel
              v-else-if="activeHomeTool === 'serverList'"
              :nodes="groupNodeList"
              :can-edit-order="appStore.nodeSelectedGroup === 'all'"
              @open-node="handleNodeClick"
              @manage-node="nodeControlDialogNode = $event"
            />
            <ProviderValuePanel v-else-if="activeHomeTool === 'providerValue'" :nodes="groupNodeList" />
            <HealthSummaryPanel v-else-if="activeHomeTool === 'healthSummary'" :nodes="groupNodeList" />
            <SnapshotExportPanel v-else-if="activeHomeTool === 'snapshotExport'" :nodes="groupNodeList" />
            <AuditLogPanel v-else-if="activeHomeTool === 'auditLog'" />
            <TransitionGroup
              v-else-if="displayedNodeList.length !== 0 && appStore.nodeViewMode === 'card'"
              :ref="setHomeOrderContainer"
              data-node-card-grid
              :data-node-card-size="appStore.nodeCardSize"
              :appear="enableNodeCardTransition && !homeOrder.editingOrder.value"
              :css="enableNodeCardTransition && !homeOrder.editingOrder.value"
              name="node-card-switch"
              tag="div"
              :class="nodeCardGridClass"
            >
              <div
                v-for="(node, index) in displayedNodeList"
                :key="`${getNodeItemTransitionKey(node)}:${deferNodeCards ? 'deferred' : 'full'}`"
                :data-server-order-item="homeOrder.editingOrder.value ? node.uuid : undefined"
                class="relative min-w-0"
                :class="[appStore.opsDashboardEnabled && 'h-full', homeOrder.editingOrder.value && 'select-none']"
                :style="getNodeItemTransitionStyle(index)"
              >
                <button
                  v-if="homeOrder.editingOrder.value"
                  type="button"
                  data-order-drag-handle
                  class="absolute right-2 top-2 z-30 inline-flex size-8 cursor-grab touch-none items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-emerald-500/30 hover:text-foreground active:cursor-grabbing"
                  :aria-label="`拖动 ${node.name}，当前第 ${index + 1} 位，共 ${displayedNodeList.length} 位`"
                  aria-describedby="home-order-instructions"
                  :title="`拖动 ${node.name}`"
                  @keydown="handleHomeOrderKeydown($event, node)"
                >
                  <Icon icon="tabler:grip-vertical" :width="17" :height="17" />
                </button>
                <div :class="homeOrder.editingOrder.value && 'pointer-events-none'">
                  <DeferredRender
                    :enabled="deferNodeCards"
                    :min-height="deferredNodeCardHeight"
                    :class="appStore.opsDashboardEnabled && 'h-full'"
                  >
                    <PandaOpsNodeCard
                      v-if="appStore.opsDashboardEnabled && isViewActive"
                      :node="node"
                      @click="handleNodeClick(node)"
                      @manage="nodeControlDialogNode = node"
                    />
                    <NodeCard
                      v-else
                      :node="node"
                      :reduce-motion="reduceDenseNodeEffects"
                      :ping-enabled="isViewActive"
                      @click="handleNodeClick(node)"
                      @ping-click="openPingDialog(node)"
                    />
                  </DeferredRender>
                </div>
              </div>
            </TransitionGroup>
            <NodeList
              v-else-if="displayedNodeList.length !== 0 && appStore.nodeViewMode === 'list'"
              :nodes="displayedNodeList"
              :transition-key="appStore.nodeSelectedGroup"
              :sort-reset-key="nodeListSortResetKey"
              :ping-enabled="isViewActive"
              :order-editing="homeOrder.editingOrder.value"
              @click="handleNodeClick"
              @ping-click="openPingDialog"
              @order-move="moveHomeOrderWithFeedback"
            />
            <div v-else class="text-muted-foreground text-center py-8">
              <Empty :description="emptyDescription" />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
    <PingMonitorDialog
      v-if="pingDialogNode"
      :open="Boolean(pingDialogNode)"
      :uuid="pingDialogNode.uuid"
      :node-name="pingDialogNode.name"
      @update:open="!$event && (pingDialogNode = null)"
    />
    <PandaOpsNodeControlDialog
      v-if="nodeControlDialogNode"
      :open="Boolean(nodeControlDialogNode)"
      :node="nodeControlDialogNode"
      @update:open="!$event && (nodeControlDialogNode = null)"
    />
  </div>
</template>

<style scoped>
.home-view--motion {
  animation: home-view-enter 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes home-view-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.home-controls-scroll {
  scrollbar-width: none;
}

.home-controls-scroll::-webkit-scrollbar {
  display: none;
}

.node-card-switch-enter-active,
.node-card-switch-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 180ms ease;
}

.node-card-switch-enter-active {
  transition-delay: var(--node-item-delay, 0ms);
}

.node-card-switch-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.node-card-switch-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
  filter: blur(3px);
}

.node-card-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.99);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .home-view--motion {
    animation: none;
  }

  .node-card-switch-enter-active,
  .node-card-switch-leave-active,
  .node-card-switch-move {
    transition: none;
    transition-delay: 0ms;
  }

  .node-card-switch-enter-from,
  .node-card-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
</style>
