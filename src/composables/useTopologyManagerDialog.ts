import type { TopologyManager } from '@/composables/useTopologyManager'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import { computed, reactive, ref } from 'vue'
import { useTopologyDialogLifecycle } from '@/composables/useTopologyDialogLifecycle'
import { useTopologyEntryDraft } from '@/composables/useTopologyEntryDraft'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { DEFAULT_PROBE, useTopologyQuickRoute } from '@/composables/useTopologyQuickRoute'
import { readTopologySegmentRecord, useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import { describeTopologyHopProbe } from '@/services/ping-task.service'
import { createTopologyPersistence } from '@/services/topology-persistence.service'
import { message } from '@/utils/message'
import { getTopologyCreatedTaskIds } from '@/utils/topologyCreatedTasks'
import { applyTopologyProbeToRoute, resolveTopologyNode } from '@/utils/topologyHelper'
import { createAutoTopologyMetric } from '@/utils/topologyModel'
import { createCustomTopologyProbe, normalizeTopologyProbeTarget, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'
import { readTopologyWriteLog } from '@/utils/topologyWriteLog'

export function useTopologyManagerDialog(
  props: { nodes: NodeData[], open: boolean },
  onOpenChange: (open: boolean) => void,
  options: { manager?: TopologyManager, waitForRepairIdle?: () => Promise<void> } = {},
) {
  const CUSTOM_PROBE = '__custom_probe__'
  const PROBE_CITIES = [...new Set(TOPOLOGY_PROBE_OPTIONS.map(option => option.city))]
  const manager = reactive(options.manager ?? useTopologyManager(() => props.nodes))

  // 由本文件持有的跨子模块共享状态：拆到 useTopologyQuickRoute/useTopologyDialogLifecycle
  // 之后，它们仍然需要读写同一份 quickConfiguring/rematching，而 catalog 的完成回调
  // （下面几行）比这两个子组合式函数都构造得早，提前声明才不用互相前向引用。
  const rematching = ref(false)
  const rematchDone = ref(false)
  const quickConfiguring = ref(false)
  const quickSourceUuid = ref('')
  const quickJumperUuid = ref('')
  const quickLandingUuid = ref('')
  const quickProbeKey = ref(DEFAULT_PROBE)
  const quickEntryLabel = ref('')
  const quickEntryTarget = ref('')

  const customEntryOptions = computed(() => {
    const entries = new Map<string, { key: string, label: string, target: string }>()
    for (const route of manager.routes) {
      const node = route.nodes[0]
      const probe = createCustomTopologyProbe(node?.name ?? '', node?.probeTarget ?? '')
      if (probe)
        entries.set(probe.key, { key: probe.key, label: probe.label, target: probe.landmarkAddress })
    }
    return [...entries.values()]
  })

  function customEntryOption(value: string) {
    return customEntryOptions.value.find(option => option.key === value)
  }

  function isCustomProbeValue(value: string): boolean {
    return value === CUSTOM_PROBE || Boolean(customEntryOption(value))
  }

  function onQuickProbeChange(): void {
    const saved = customEntryOption(quickProbeKey.value)
    if (!saved)
      return
    quickEntryLabel.value = saved.label
    quickEntryTarget.value = saved.target
  }

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
    reservedEntryNames,
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
    const node = resolveTopologyNode(props.nodes, metric.nodeName, route.nodes[Math.max(1, metricIndex)]?.uuid)
    if (!node) {
      return [`第 ${routeIndex + 1} 条线路的探测来源“${metric.nodeName}”不存在或名称重复`]
    }
    if (taskErrors.value[node.uuid])
      return [`第 ${routeIndex + 1} 条线路无法验证探测任务：${taskErrors.value[node.uuid]}`]
    if (!taskLoaded.value[node.uuid])
      return []
    const pending = metricIndex >= 1
      ? readTopologySegmentRecord(pendingRouteTasks.value, route.id, metricIndex)
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
      || Object.keys(routeRetiredTasks.value).length > 0
      || Object.keys(routeEntryRetiredTasks.value).length > 0
  }
  const taskValidationPending = computed(() => rematching.value || Object.values(routeTaskPlanning.value).some(Boolean) || manager.routes.some(route => route.metrics.some((metric) => {
    if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
      return false
    const metricIndex = route.metrics.indexOf(metric)
    const node = resolveTopologyNode(props.nodes, metric.nodeName, route.nodes[Math.max(1, metricIndex)]?.uuid)
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
    planner: { pendingRouteTasks, planRouteTasks },
    persistence: { persistRoutes: persistence.persistRoutes },
    quickConfiguring,
    quickSourceUuid,
    quickJumperUuid,
    quickLandingUuid,
    quickProbeKey,
    quickEntryLabel,
    quickEntryTarget,
    isCustomProbeValue,
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
    waitForRepairIdle: options.waitForRepairIdle,
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
    const incomingMetric = route.metrics[index - 1]
    if (index > 1 && incomingMetric)
      manager.setMetricMode(incomingMetric, Boolean(nodeName.trim()))
    if (index > 0)
      void planRouteTasksAndSave(route)
  }

  function selectRouteJumper(route: TopologyRouteConfig, nodeName: string): void {
    bumpRouteRun(route.id)
    clearPendingRouteTask(route.id)
    clearRouteProbeState(route.id)
    const emptyMetric = createAutoTopologyMetric
    if (!nodeName.trim()) {
      if (route.nodes.length >= 4) {
        route.nodes.splice(2, 1)
        route.metrics.splice(1, 2, emptyMetric())
        if (route.nodes[2])
          route.nodes[2].role = '落地机'
      }
    }
    else {
      if (route.nodes.length < 4) {
        const landing = route.nodes[2] ?? { name: '', region: '', role: '落地机' }
        route.nodes.splice(2, 1, { name: '', region: '', role: '跳板' }, landing)
        route.metrics.splice(1, 1, emptyMetric(), emptyMetric())
      }
      manager.selectNode(route, 2, nodeName)
      if (route.nodes[2])
        route.nodes[2].role = '跳板'
      if (route.nodes[3])
        route.nodes[3].role = '落地机'
    }
    void planRouteTasksAndSave(route)
  }

  function routeSegmentPending(route: TopologyRouteConfig, segmentIndex: number) {
    return readTopologySegmentRecord(pendingRouteTasks.value, route.id, segmentIndex)
  }

  function routeSegmentState(route: TopologyRouteConfig, segmentIndex: number) {
    return readTopologySegmentRecord(routeProbeStates.value, route.id, segmentIndex)
  }

  function routeProbeValue(route: TopologyRouteConfig): string {
    const custom = createCustomTopologyProbe(route.nodes[0]?.name ?? '', route.nodes[0]?.probeTarget ?? '')
    return custom?.key || entryDraft.probeValue(route)
  }

  function selectRouteProbe(route: TopologyRouteConfig, probeKey: string): void {
    if (!probeKey)
      return
    const savedCustom = customEntryOption(probeKey)
    if (savedCustom) {
      route.nodes[0] = { name: savedCustom.label, region: 'CN', role: '入口', probeTarget: savedCustom.target }
      route.metrics[0] = createAutoTopologyMetric()
      void planRouteTasksAndSave(route)
      return
    }
    if (probeKey === CUSTOM_PROBE) {
      if (!entryDraft.restore(route)) {
        route.nodes[0] = { name: '自定义入口', region: '', role: '入口' }
        route.metrics[0] = createAutoTopologyMetric()
      }
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

  function updateRouteEntryLabel(route: TopologyRouteConfig, label: string): void {
    const value = label.trim()
    if (!value || !route.nodes[0])
      return
    route.nodes[0].name = value
    route.nodes[0].region = ''
    route.nodes[0].role = '入口'
    route.metrics[0] = createAutoTopologyMetric()
    if (route.nodes[0].probeTarget)
      void planRouteTasksAndSave(route)
    else
      void persistDraft('自定义入口已保存。')
  }

  function updateRouteEntryTarget(route: TopologyRouteConfig, target: string): void {
    const raw = target.trim()
    const value = normalizeTopologyProbeTarget(raw)
    if (raw && !value) {
      window.$message?.error('请输入有效的 IP 或域名，不要包含协议、端口或路径。')
      return
    }
    const entry = route.nodes[0]
    if (!entry)
      return
    if (value)
      entry.probeTarget = value
    else
      delete entry.probeTarget
    entry.region = value ? 'CN' : ''
    route.metrics[0] = createAutoTopologyMetric()
    void planRouteTasksAndSave(route)
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
    customEntryOptions,
    CUSTOM_PROBE,
    selectClass: quickRoute.selectClass,
    quickSourceUuid,
    quickJumperUuid,
    onQuickSourceChange: quickRoute.onQuickSourceChange,
    onQuickJumperChange: quickRoute.onQuickJumperChange,
    nodeOption: quickRoute.nodeOption,
    quickLandingUuid,
    quickLandingOptions: quickRoute.quickLandingOptions,
    quickJumperOptions: quickRoute.quickJumperOptions,
    quickEntryLabel,
    quickEntryTarget,
    isCustomProbeValue,
    onQuickProbeChange,
    addQuickRoute: quickRoute.addQuickRoute,
    quickTaskError: quickRoute.quickTaskError,
    validationErrors,
    routeProbeValue,
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
    updateRouteEntryLabel,
    updateRouteEntryTarget,
    selectRouteNode,
    selectRouteJumper,
    routeEntryHint,
    routeEntryHintTone,
    routeHint,
    routeHintTone,
    routeSegmentPending,
    routeSegmentState,
    writeLog,
    formatWriteLogTime,
    reset: lifecycle.reset,
    taskValidationPending,
    hasPendingWork,
    persistBlockingErrors,
    save,
  }
}
