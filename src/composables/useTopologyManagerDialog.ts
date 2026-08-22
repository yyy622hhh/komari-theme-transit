import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import { computed, reactive, ref } from 'vue'
import { useTopologyDialogLifecycle } from '@/composables/useTopologyDialogLifecycle'
import { useTopologyEntryDraft } from '@/composables/useTopologyEntryDraft'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { DEFAULT_PROBE, useTopologyQuickRoute } from '@/composables/useTopologyQuickRoute'
import { useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import { describeTopologyHopProbe } from '@/services/ping-task.service'
import { createTopologyPersistence } from '@/services/topology-persistence.service'
import { message } from '@/utils/message'
import { getTopologyCreatedTaskIds } from '@/utils/topologyCreatedTasks'
import { applyTopologyProbeToRoute, resolveTopologyNode } from '@/utils/topologyHelper'
import { TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'
import { readTopologyWriteLog } from '@/utils/topologyWriteLog'

export function useTopologyManagerDialog(
  props: { nodes: NodeData[], open: boolean },
  onOpenChange: (open: boolean) => void,
) {
  const CUSTOM_PROBE = '__custom_probe__'
  const PROBE_CITIES = [...new Set(TOPOLOGY_PROBE_OPTIONS.map(option => option.city))]
  const manager = reactive(useTopologyManager(() => props.nodes))

  // 由本文件持有的跨子模块共享状态：拆到 useTopologyQuickRoute/useTopologyDialogLifecycle
  // 之后，它们仍然需要读写同一份 quickConfiguring/rematching，而 catalog 的完成回调
  // （下面几行）比这两个子组合式函数都构造得早，提前声明才不用互相前向引用。
  const rematching = ref(false)
  const rematchDone = ref(false)
  const quickConfiguring = ref(false)
  const quickSourceUuid = ref('')
  const quickLandingUuid = ref('')
  const quickProbeKey = ref(DEFAULT_PROBE)

  const catalog = useTopologyTaskCatalog(
    () => props.nodes,
    name => manager.isAmbiguousNodeName(name),
    () => {
      if (props.open && !rematching.value && !quickConfiguring.value && hasPendingWork())
        void persistDraft('线路已保存。')
    },
  )
  const planner = useTopologyRoutePlanner(() => props.nodes, manager, catalog, () => props.open)
  const {
    taskOptions,
    taskErrors,
    taskLoaded,
    loadTasks,
    rememberTask,
  } = catalog
  const {
    routeProbeStates,
    routeEntryProbeStates,
    pendingRouteTasks,
    pendingEntryTasks,
    routeRetiredTasks,
    routeEntryRetiredTasks,
    routeTaskPlanning,
    routeTaskErrors,
    bumpRouteRun,
    cancelRouteTaskPlanning,
    clearRouteTaskPlanning,
    clearPendingRouteTask,
    clearPendingEntryTask,
    clearRouteTaskError,
    clearRouteProbeState,
    clearRouteEntryProbeState,
    rememberRetiredTasks,
    reservedEntryNames,
    planEntryTaskState,
    applyEntryTaskState,
    planRouteTasks,
    routeHopTask,
    routeHint,
    routeHintTone,
    routeEntryHint,
    routeEntryHintTone,
  } = planner
  const entryDraft = useTopologyEntryDraft(CUSTOM_PROBE)
  const sessionCreatedTaskIds = getTopologyCreatedTaskIds()
  let quickConfigurationRun = 0
  let dialogSession = 0
  const getDialogSession = () => dialogSession
  const bumpDialogSession = () => (dialogSession += 1)
  const getQuickConfigurationRun = () => quickConfigurationRun
  const bumpQuickConfigurationRun = () => (quickConfigurationRun += 1)

  /**
   * 主题对后端做过什么的本地流水。空的时候整块不渲染——绝大多数会话不会有写操作，
   * 没有理由给对话框加一段常驻的空白区。
   */
  const writeLog = ref(readTopologyWriteLog())
  function refreshWriteLog(): void {
    writeLog.value = readTopologyWriteLog()
  }
  function formatWriteLogTime(at: number): string {
    return new Date(at).toLocaleString('zh-CN', { hour12: false })
  }

  const taskBindingErrors = computed(() => manager.routes.flatMap((route, routeIndex) => route.metrics.flatMap((metric, metricIndex) => {
    if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
      return []
    const node = resolveTopologyNode(props.nodes, metric.nodeName, route.nodes[1]?.uuid)
    if (!node) {
      return [`第 ${routeIndex + 1} 条线路的探测来源“${metric.nodeName}”不存在或名称重复`]
    }
    if (taskErrors.value[node.uuid])
      return [`第 ${routeIndex + 1} 条线路无法验证探测任务：${taskErrors.value[node.uuid]}`]
    if (!taskLoaded.value[node.uuid])
      return []
    const pending = metricIndex === 1
      ? pendingRouteTasks.value[route.id]
      : metricIndex === 0
        ? pendingEntryTasks.value[route.id]
        : undefined
    if (pending?.sourceUuid === node.uuid && pending.taskName === metric.taskFilter)
      return []
    return (taskOptions.value[node.uuid] ?? []).includes(metric.taskFilter)
      ? []
      : [`第 ${routeIndex + 1} 条线路请重新选择${metricIndex === 0 ? '入口或线路机' : '落地机'}，当前探测任务已失效。`]
  })))
  const persistBlockingErrors = computed(() => [
    ...manager.validationErrors,
    ...taskBindingErrors.value,
  ])
  const validationErrors = computed(() => [
    ...persistBlockingErrors.value,
    ...Object.entries(routeTaskErrors.value).filter(([, error]) => Boolean(error)).map(([routeId, error]) => {
      const routeIndex = manager.routes.findIndex(route => route.id === Number(routeId))
      return routeIndex >= 0 ? `第 ${routeIndex + 1} 条线路：${error}` : error
    }),
  ])
  /**
   * 入口换挡可能不改序列化后的 metrics，所以还要看排队中的创建任务。
   * 普通函数：catalog 回调声明更早，依赖函数声明提升。
   */
  function hasPendingWork(): boolean {
    return manager.dirty
      || Object.keys(pendingRouteTasks.value).length > 0
      || Object.keys(pendingEntryTasks.value).length > 0
  }
  const taskValidationPending = computed(() => rematching.value || Object.values(routeTaskPlanning.value).some(Boolean) || manager.routes.some(route => route.metrics.some((metric) => {
    if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
      return false
    const node = resolveTopologyNode(props.nodes, metric.nodeName, route.nodes[1]?.uuid)
    return Boolean(node && !taskLoaded.value[node.uuid] && !taskErrors.value[node.uuid])
  })))

  const persistence = createTopologyPersistence({
    props,
    manager,
    taskValidationPending,
    persistBlockingErrors,
    pendingRouteTasks,
    pendingEntryTasks,
    routeRetiredTasks,
    routeEntryRetiredTasks,
    routeTaskErrors,
    sessionCreatedTaskIds,
    findEndpoint,
    rememberTask,
    clearPendingRouteTask,
    clearPendingEntryTask,
    clearRouteTaskError,
    hasPendingWork,
    getDialogSession,
    getQuickConfigurationRun,
    onOpenChange,
    refreshWriteLog,
    message,
  })
  const managerBusy = computed(() => manager.saving || quickConfiguring.value || rematching.value || persistence.persisting.value)

  const quickRoute = useTopologyQuickRoute({
    props,
    manager,
    catalog: { loadTasks, rememberTask, taskErrors },
    planner: { routeProbeStates, pendingRouteTasks, rememberRetiredTasks, planEntryTaskState, applyEntryTaskState, clearRouteProbeState },
    persistence: { persistRoutes: persistence.persistRoutes },
    quickConfiguring,
    quickSourceUuid,
    quickLandingUuid,
    quickProbeKey,
    bumpQuickConfigurationRun,
    getQuickConfigurationRun,
  })

  const lifecycle = useTopologyDialogLifecycle({
    props,
    // `manager` 是 reactive() 包过的代理，`routes` 内部用 ref().value 整体替换
    // （见 useTopologyManager.ts 的 reset），必须传代理本身而不是解构快照，
    // 否则拿到的是构造那一刻的旧数组，读不到之后的替换。
    manager,
    catalog: { reset: catalog.reset },
    planner: { reset: planner.reset, planRouteTasks, cancelRouteTaskPlanning },
    entryDraft: { reset: entryDraft.reset },
    persistence: { waitForIdle: persistence.waitForIdle, persistRoutes: persistence.persistRoutes, abort: persistence.abort },
    rematching,
    rematchDone,
    managerBusy,
    syncQuickSelections: quickRoute.syncQuickSelections,
    resetQuickProbeKey: quickRoute.resetQuickProbeKey,
    cancelQuickConfigurationRun: quickRoute.cancel,
    hasPendingWork,
    persistBlockingErrors,
    refreshWriteLog,
    getDialogSession,
    bumpDialogSession,
  })

  const isOpen = computed({
    get: () => props.open,
    set: value => onOpenChange(value),
  })

  function selectRouteNode(route: TopologyRouteConfig, index: number, nodeName: string): void {
    if (index > 0) {
      clearPendingRouteTask(route.id)
      bumpRouteRun(route.id)
    }
    manager.selectNode(route, index, nodeName)
    if (index === 2 && route.metrics[1]) {
      manager.setMetricMode(route.metrics[1], Boolean(nodeName.trim()))
      if (nodeName.trim())
        route.metrics[1].nodeName = route.nodes[1]?.name.trim() ?? ''
    }
    if (index > 0)
      void planRouteTasksAndSave(route)
  }

  function selectRouteProbe(route: TopologyRouteConfig, probeKey: string): void {
    if (!probeKey)
      return
    if (probeKey === CUSTOM_PROBE) {
      if (!entryDraft.restore(route))
        return
      void planRouteTasksAndSave(route)
      return
    }
    if (entryDraft.probeValue(route) === CUSTOM_PROBE)
      entryDraft.remember(route)
    const sourceName = route.nodes[1]?.name.trim() ?? ''
    const source = resolveTopologyNode(props.nodes, sourceName, route.nodes[1]?.uuid)
    applyTopologyProbeToRoute(
      route,
      probeKey,
      sourceName,
      source ? taskOptions.value[source.uuid] ?? [] : [],
      reservedEntryNames(route),
    )
    if (sourceName)
      void planRouteTasksAndSave(route)
    else
      void persistDraft('线路已保存。')
  }

  function removeRoute(index: number): void {
    const route = manager.routes[index]
    if (!route)
      return
    bumpRouteRun(route.id)
    clearPendingRouteTask(route.id)
    clearPendingEntryTask(route.id)
    clearRouteProbeState(route.id)
    clearRouteEntryProbeState(route.id)
    clearRouteTaskError(route.id)
    clearRouteTaskPlanning(route.id)
    entryDraft.remove(route.id)
    manager.removeRoute(index)
    void persistDraft('线路已删除。')
  }

  function moveRoute(index: number, offset: -1 | 1): void {
    manager.moveRoute(index, offset)
    void persistDraft('线路顺序已保存。')
  }

  async function planRouteTasksAndSave(route: TopologyRouteConfig): Promise<void> {
    await planRouteTasks(route)
    if (!props.open || rematching.value)
      return
    await persistDraft('线路已保存。')
  }

  async function persistDraft(successMessage: string): Promise<void> {
    if (!props.open || rematching.value || !hasPendingWork() || persistBlockingErrors.value.length)
      return
    if (taskValidationPending.value)
      return
    await persistence.persistRoutes({ keepOpen: true, successMessage, quiet: true })
  }

  function findEndpoint(uuid: string) {
    return props.nodes.find(node => node.uuid === uuid)
      ?? manager.quickNodes.find(node => node.uuid === uuid)
  }

  async function save(): Promise<void> {
    await persistence.persistRoutes()
  }

  return {
    nodes: computed(() => props.nodes),
    isOpen,
    manager,
    managerBusy,
    rematchDone,
    recheckNow: lifecycle.recheckNow,
    rematching,
    quickProbeKey,
    quickConfiguring,
    PROBE_CITIES,
    TOPOLOGY_PROBE_OPTIONS,
    CUSTOM_PROBE,
    selectClass: quickRoute.selectClass,
    quickSourceUuid,
    onQuickSourceChange: quickRoute.onQuickSourceChange,
    nodeOption: quickRoute.nodeOption,
    quickLandingUuid,
    quickLandingOptions: quickRoute.quickLandingOptions,
    addQuickRoute: quickRoute.addQuickRoute,
    quickTaskError: quickRoute.quickTaskError,
    validationErrors,
    routeProbeValue: entryDraft.probeValue,
    pendingEntryTasks,
    routeEntryProbeStates,
    describeTopologyHopProbe,
    routeHopTask,
    pendingRouteTasks,
    routeProbeStates,
    moveRoute,
    removeRoute,
    hasCustomEntryOption: entryDraft.hasOption,
    customEntryLabel: entryDraft.label,
    selectRouteProbe,
    selectRouteNode,
    routeEntryHint,
    routeEntryHintTone,
    routeHint,
    routeHintTone,
    writeLog,
    formatWriteLogTime,
    reset: lifecycle.reset,
    taskValidationPending,
    hasPendingWork,
    persistBlockingErrors,
    save,
  }
}
