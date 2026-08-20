import type { NodeData } from '@/stores/nodes'
import type { TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { useTopologyEntryDraft } from '@/composables/useTopologyEntryDraft'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'
import { describeTopologyHopProbe, topologyPingTargets } from '@/services/ping-task.service'
import { createTopologyPersistence } from '@/services/topology-persistence.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { message } from '@/utils/message'
import { getTopologyCreatedTaskIds } from '@/utils/topologyCreatedTasks'
import { applyTopologyProbeToRoute, listUnusedQuickLandingUuids, nextQuickLandingUuid, resolveTopologyNode } from '@/utils/topologyHelper'
import { TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'
import { readTopologyWriteLog } from '@/utils/topologyWriteLog'

export function useTopologyManagerDialog(
  props: { nodes: NodeData[], open: boolean },
  onOpenChange: (open: boolean) => void,
) {
  const CUSTOM_PROBE = '__custom_probe__'
  const DEFAULT_PROBE = TOPOLOGY_PROBE_OPTIONS[0]!.key
  const PROBE_CITIES = [...new Set(TOPOLOGY_PROBE_OPTIONS.map(option => option.city))]
  const manager = reactive(useTopologyManager(() => props.nodes))
  const quickConfiguring = ref(false)
  const rematching = ref(false)
  const rematchDone = ref(false)
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
  const quickSourceUuid = ref('')
  const quickLandingUuid = ref('')
  const quickProbeKey = ref(DEFAULT_PROBE)
  const sessionCreatedTaskIds = getTopologyCreatedTaskIds()
  let recheckTimer: ReturnType<typeof setInterval> | null = null
  let quickConfigurationRun = 0
  let dialogSession = 0

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

  const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
  const quickLandingCandidates = computed(() => quickLandingOptions.value.filter(node => topologyPingTargets(node).length > 0))
  const quickSourceName = computed(() => manager.quickNodes.find(node => node.uuid === quickSourceUuid.value)?.name ?? '')
  const quickTaskError = computed(() => quickSourceUuid.value ? taskErrors.value[quickSourceUuid.value] ?? '' : '')
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
    getDialogSession: () => dialogSession,
    getQuickConfigurationRun: () => quickConfigurationRun,
    onOpenChange,
    refreshWriteLog,
    message,
  })
  const managerBusy = computed(() => manager.saving || quickConfiguring.value || rematching.value || persistence.persisting.value)

  function unusedQuickLandingUuids(): string[] {
    return listUnusedQuickLandingUuids(
      manager.routes,
      quickSourceName.value,
      manager.quickNodes,
      quickSourceUuid.value,
    )
  }

  function syncQuickSelections(initialize = false): void {
    const sources = manager.quickNodes
    if (!sources.some(node => node.uuid === quickSourceUuid.value))
      quickSourceUuid.value = sources[0]?.uuid ?? ''
    const pingableLandings = new Set(quickLandingCandidates.value.map(node => node.uuid))
    const landingUuids = sources
      .map(node => node.uuid)
      .filter((uuid): uuid is string => Boolean(uuid) && pingableLandings.has(uuid))
    quickLandingUuid.value = nextQuickLandingUuid(
      quickSourceUuid.value,
      quickLandingUuid.value,
      landingUuids,
      initialize,
      unusedQuickLandingUuids().filter(uuid => pingableLandings.has(uuid)),
    )
  }

  const isOpen = computed({
    get: () => props.open,
    set: value => onOpenChange(value),
  })

  watch(() => props.open, (value) => {
    dialogSession += 1
    refreshWriteLog()
    const session = dialogSession
    if (!value) {
      rematching.value = false
      rematchDone.value = false
      stopRecheckTimer()
      cancelQuickConfiguration()
      cancelRouteTaskPlanning()
      return
    }
    rematchDone.value = false
    rematching.value = true
    quickProbeKey.value = DEFAULT_PROBE
    void (async () => {
      await persistence.waitForIdle()
      if (session !== dialogSession || !props.open)
        return
      manager.reset()
      catalog.reset()
      planner.reset()
      entryDraft.reset()
      syncQuickSelections()
      startRecheckTimer()
      await rematchOpenRoutes(session)
    })()
  }, { immediate: true })

  watch(() => manager.quickNodes.map(node => node.uuid).join('|'), () => {
    if (props.open)
      syncQuickSelections()
  })

  onScopeDispose(() => {
    dialogSession += 1
    stopRecheckTimer()
    cancelQuickConfiguration()
    cancelRouteTaskPlanning()
  })

  function stopRecheckTimer(): void {
    if (!recheckTimer)
      return
    clearInterval(recheckTimer)
    recheckTimer = null
  }

  /**
   * 对话框开着的时候定期复检一轮：刚建好的任务要过一会儿才出样本，判死后才能
   * 自动换探测方式。操作者什么都不用点，看着提示行变绿即可。
   */
  function startRecheckTimer(): void {
    stopRecheckTimer()
    if (typeof window === 'undefined')
      return
    recheckTimer = setInterval(() => {
      if (props.open && !managerBusy.value)
        void rematchOpenRoutes(dialogSession)
    }, OPS_TOPOLOGY_HOP_PROBE.recheckIntervalMs)
  }

  function recheckNow(): void {
    if (!props.open || managerBusy.value)
      return
    void rematchOpenRoutes(dialogSession)
  }

  function cancelQuickConfiguration(): void {
    quickConfigurationRun += 1
    persistence.abort()
    quickConfiguring.value = false
  }

  function reset(): void {
    cancelQuickConfiguration()
    cancelRouteTaskPlanning()
    rematchDone.value = false
    rematching.value = true
    const session = dialogSession
    void (async () => {
      await persistence.waitForIdle()
      if (session !== dialogSession || !props.open)
        return
      manager.reset()
      catalog.reset()
      planner.reset()
      entryDraft.reset()
      await rematchOpenRoutes(session)
    })()
  }

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

  async function rematchOpenRoutes(session: number): Promise<void> {
    rematching.value = true
    try {
      await Promise.all(Array.from(manager.routes, (route) => {
        if (session !== dialogSession || !props.open)
          return Promise.resolve()
        return planRouteTasks(route)
      }))
      if (session !== dialogSession || !props.open)
        return
      if (hasPendingWork() && !persistBlockingErrors.value.length) {
        await persistence.persistRoutes({
          keepOpen: true,
          ignoreBusy: true,
          successMessage: '已按当前节点校正并保存。',
        })
      }
    }
    finally {
      if (session === dialogSession) {
        rematching.value = false
        rematchDone.value = true
      }
    }
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

  function onQuickSourceChange(): void {
    const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
    if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName, quickSourceUuid.value, quickLandingUuid.value) >= 0)
      quickLandingUuid.value = ''
    if (!quickLandingUuid.value)
      syncQuickSelections()
    if (quickSourceName.value)
      void loadTasks(quickSourceName.value, quickSourceUuid.value)
  }

  function focusTopologyRoute(routeId: number): void {
    const routeElement = document.querySelector<HTMLElement>(`[data-topology-route-id="${routeId}"]`)
    routeElement?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true })
    routeElement?.scrollIntoView({ block: 'nearest' })
  }

  async function addQuickRoute(): Promise<void> {
    if (quickConfiguring.value)
      return
    const source = manager.quickNodes.find(node => node.uuid === quickSourceUuid.value) ?? manager.quickSourceNode
    if (!source?.uuid) {
      window.$message?.error('请先选择一台线路机。')
      return
    }
    const runId = ++quickConfigurationRun
    const selectedSourceUuid = source.uuid
    const selectedLandingUuid = quickLandingUuid.value
    const selectedProbeKey = quickProbeKey.value
    quickConfiguring.value = true
    try {
      const result = await loadTasks(source.name, source.uuid)
      if (runId !== quickConfigurationRun || !props.open)
        return
      if (result.error) {
        window.$message?.error(result.error)
        return
      }
      const latestSource = manager.quickNodes.find(node => node.uuid === selectedSourceUuid)
      const latestLanding = selectedLandingUuid ? manager.quickNodes.find(node => node.uuid === selectedLandingUuid) : undefined
      if (!latestSource || (selectedLandingUuid && !latestLanding)) {
        window.$message?.warning('节点已变化，请重新选择后添加。')
        return
      }
      if (latestSource.online === false || latestLanding?.online === false) {
        window.$message?.warning('线路机或落地机已离线，请上线后再添加。')
        return
      }
      // 入口任务由 planEntryTaskState/applyEntryTaskState 规划，保存时统一创建。
      const planned = latestLanding ? await planWorkingHopTask(latestSource, latestLanding) : null
      if (runId !== quickConfigurationRun || !props.open)
        return
      if (planned && !planned.needsCreation)
        rememberTask(latestSource.uuid, planned.task.name)
      const configured = manager.addQuickRoute(
        [...new Set([...result.tasks, ...(planned ? [planned.task.name] : [])])],
        selectedSourceUuid,
        { landingUuid: selectedLandingUuid || null, hopTask: planned?.task.name ?? '', probeKey: selectedProbeKey },
      )
      if (!configured) {
        window.$message?.error('所选节点已变化，请重新选择后添加。')
        return
      }
      const nextPending = { ...pendingRouteTasks.value }
      if (planned?.needsCreation && latestLanding) {
        nextPending[configured.route.id] = {
          sourceUuid: latestSource.uuid,
          targetUuid: latestLanding.uuid,
          taskName: planned.task.name,
          probe: planned.probe,
        }
      }
      else {
        delete nextPending[configured.route.id]
      }
      pendingRouteTasks.value = nextPending
      if (planned) {
        routeProbeStates.value = {
          ...routeProbeStates.value,
          [configured.route.id]: {
            probe: planned.probe,
            verdict: planned.verdict,
            exhausted: planned.exhausted,
            switchedFrom: planned.switchedFrom,
            targetAddress: planned.targetAddress,
          },
        }
        rememberRetiredTasks(configured.route.id, planned.retiredTasks)
      }
      else {
        clearRouteProbeState(configured.route.id)
      }
      const entryState = await planEntryTaskState(configured.route, latestSource.uuid, latestSource.name)
      if (runId !== quickConfigurationRun || !props.open)
        return
      applyEntryTaskState(configured.route, latestSource.uuid, latestSource.name, entryState)
      if (configured.created) {
        quickLandingUuid.value = ''
        syncQuickSelections()
      }
      const persistResult = await persistence.persistRoutes({
        keepOpen: true,
        runId,
        successMessage: configured.created
          ? (planned?.needsCreation ? '已添加线路并创建探测任务。' : '已添加并保存。')
          : '已更新现有线路并保存。',
      })
      if (runId !== quickConfigurationRun || !props.open || persistResult === 'invalid')
        return
      await nextTick()
      setTimeout(() => {
        if (runId === quickConfigurationRun && props.open)
          focusTopologyRoute(configured.route.id)
      })
    }
    catch (error) {
      if (runId === quickConfigurationRun && props.open)
        window.$message?.error(error instanceof Error ? error.message : '添加线路失败。')
    }
    finally {
      if (runId === quickConfigurationRun)
        quickConfiguring.value = false
    }
  }

  const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring'

  /**
   * 下拉选项的可用性与标注，线路机/落地机共用一套口径。
   *
   * 原则是「不能用的选项要在点下去之前就说清楚」：以前无公网 IP 的落地机可以照常
   * 选中，直到点了「添加线路」才弹一句红字报错，而重名节点早就是预先置灰的。
   */
  function nodeOption(option: TopologyQuickNode, role: 'source' | 'landing', otherUuid = '', otherName = ''): { disabled: boolean, label: string } {
    const name = option.name
    if (manager.isAmbiguousNodeName(name) && !option.uuid)
      return { disabled: true, label: `${name}（重名，不可用）` }
    // 落地机是被 Ping 的一方，没有可探测地址就建不出任务；线路机只负责发探测，不需要地址。
    if (role === 'landing' && !topologyPingTargets(option).length)
      return { disabled: true, label: `${name}（无公网 IP，不可用）` }
    if (otherUuid && option.uuid === otherUuid)
      return { disabled: true, label: name }
    if (!otherUuid && otherName && name === otherName)
      return { disabled: true, label: name }
    return { disabled: false, label: option.online === false ? `${name}（离线）` : name }
  }

  return {
    nodes: computed(() => props.nodes),
    isOpen,
    manager,
    managerBusy,
    rematchDone,
    recheckNow,
    rematching,
    quickProbeKey,
    quickConfiguring,
    PROBE_CITIES,
    TOPOLOGY_PROBE_OPTIONS,
    CUSTOM_PROBE,
    selectClass,
    quickSourceUuid,
    onQuickSourceChange,
    nodeOption,
    quickLandingUuid,
    quickLandingOptions,
    addQuickRoute,
    quickTaskError,
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
    reset,
    taskValidationPending,
    hasPendingWork,
    persistBlockingErrors,
    save,
  }
}
