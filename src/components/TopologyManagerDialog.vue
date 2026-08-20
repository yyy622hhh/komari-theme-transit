<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyHelper'
import { Icon } from '@iconify/vue'
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'
import { deleteTopologyPingTasks, describeTopologyHopProbe, ensureTopologyEntryPingTask, ensureTopologyPingTask, loadAdminPingTasks, topologyPingTargets } from '@/services/ping-task.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { listOwnedRetiredTaskIds, listOwnedUnboundTaskIds, liveTopologyTaskNames } from '@/services/topology-repair.service'
import { getTopologyCreatedTaskIds, persistTopologyCreatedTaskIds, rememberTopologyCreatedTaskId } from '@/utils/topologyCreatedTasks'
import { applyTopologyProbeToRoute, getTopologyRouteProbeKey, listUnusedQuickLandingUuids, nextQuickLandingUuid, resolveTopologyNode, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
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
    if (props.open && !rematching.value && !quickConfiguring.value && manager.dirty)
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
  pendingRouteTasks,
  routeRetiredTasks,
  routeTaskPlanning,
  routeTaskErrors,
  bumpRouteRun,
  cancelRouteTaskPlanning,
  clearRouteTaskPlanning,
  clearPendingRouteTask,
  clearRouteTaskError,
  clearRouteProbeState,
  rememberRetiredTasks,
  reservedEntryNames,
  planRouteTasks,
  routeHopTask,
  routeHint,
  routeHintTone,
  routeEntryHint,
  routeEntryHintTone,
} = planner
/**
 * 切到预设入口之前，先把自定义入口整段存下来。
 *
 * `applyTopologyProbeToRoute` 会直接覆盖 `nodes[0]` 和 `metrics[0]`，而入口下拉
 * 以前只在「当前就是自定义」时才渲染自定义项——一旦切走就再也切不回来，且改动
 * 立刻自动保存，「恢复已保存配置」恢复的正是刚存下的那一份，等于手写的自定义
 * 入口一次误触就永久丢失。存快照后这个操作才是可逆的。
 */
const customEntrySnapshots = ref<Record<number, { node: TopologyNodeConfig, metric: TopologyMetricConfig }>>({})
const quickSourceUuid = ref('')
const quickLandingUuid = ref('')
const quickProbeKey = ref(DEFAULT_PROBE)
const sessionCreatedTaskIds = getTopologyCreatedTaskIds()
let recheckTimer: ReturnType<typeof setInterval> | null = null
let quickConfigurationRun = 0
let dialogSession = 0
let persistTail: Promise<unknown> = Promise.resolve()
let saveTaskController: AbortController | null = null
const persisting = ref(false)

const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
/** 能作为落地机的候选：必须有可 Ping 的地址，否则不能拿来当默认选中项。 */
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
  const pending = metricIndex === 1 ? pendingRouteTasks.value[route.id] : undefined
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
const managerBusy = computed(() => manager.saving || quickConfiguring.value || rematching.value || persisting.value)
const taskValidationPending = computed(() => rematching.value || Object.values(routeTaskPlanning.value).some(Boolean) || manager.routes.some(route => route.metrics.some((metric) => {
  if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
    return false
  const node = resolveTopologyNode(props.nodes, metric.nodeName, route.nodes[1]?.uuid)
  return Boolean(node && !taskLoaded.value[node.uuid] && !taskErrors.value[node.uuid])
})))

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
  // 只把「可 Ping」的节点交给默认选择，否则下拉会停在一个已置灰的选项上。
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
  set: value => emit('update:open', value),
})

watch(() => props.open, (value) => {
  dialogSession += 1
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
    await persistTail
    if (session !== dialogSession || !props.open)
      return
    manager.reset()
    catalog.reset()
    planner.reset()
    customEntrySnapshots.value = {}
    syncQuickSelections(true)
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
  saveTaskController?.abort()
  saveTaskController = null
  quickConfiguring.value = false
}

function reset(): void {
  cancelQuickConfiguration()
  cancelRouteTaskPlanning()
  rematchDone.value = false
  rematching.value = true
  const session = dialogSession
  void (async () => {
    await persistTail
    if (session !== dialogSession || !props.open)
      return
    manager.reset()
    catalog.reset()
    planner.reset()
    customEntrySnapshots.value = {}
    await rematchOpenRoutes(session)
  })()
}

function routeProbeValue(route: TopologyRouteConfig): string {
  return getTopologyRouteProbeKey(route) || CUSTOM_PROBE
}

function routeProbeLabel(route: TopologyRouteConfig): string {
  return route.nodes[0]?.name.trim() || '自定义入口'
}

/**
 * 清理本页面会话中由主题创建、随后被换掉的旧探测任务。
 *
 * 名称不是所有权证明：既有任务即使恰好使用 Transit 命名也不能删除。这里只接受
 * ensure 明确返回 created=true 后记录的 ID，并在配置保存成功后再次确认没有线路绑定。
 */
async function retireReplacedTasks(): Promise<void> {
  const entries = Object.entries(routeRetiredTasks.value)
  routeRetiredTasks.value = {}
  const boundNames = liveTopologyTaskNames(manager.routes)
  const ids = new Set(listOwnedRetiredTaskIds(
    entries.flatMap(([, tasks]) => tasks),
    sessionCreatedTaskIds,
    boundNames,
  ))
  try {
    const tasks = await loadAdminPingTasks({ fresh: true })
    for (const id of listOwnedUnboundTaskIds(sessionCreatedTaskIds, tasks, boundNames))
      ids.add(id)
    for (const id of [...sessionCreatedTaskIds]) {
      if (!tasks.some(task => task.id === id))
        sessionCreatedTaskIds.delete(id)
    }
  }
  catch {
    // 任务列表读失败时仍按规划阶段记下的 hop 候选清理。
  }
  if (ids.size && await deleteTopologyPingTasks([...ids])) {
    for (const id of ids)
      sessionCreatedTaskIds.delete(id)
  }
  persistTopologyCreatedTaskIds(sessionCreatedTaskIds)
}

async function cleanupCreatedTasks(taskIds: ReadonlySet<number>): Promise<void> {
  const ids = [...taskIds]
  if (!ids.length || !await deleteTopologyPingTasks(ids))
    return
  for (const id of ids)
    sessionCreatedTaskIds.delete(id)
  persistTopologyCreatedTaskIds(sessionCreatedTaskIds)
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

function rememberCustomEntry(route: TopologyRouteConfig): void {
  const node = route.nodes[0]
  const metric = route.metrics[0]
  if (!node || !metric)
    return
  customEntrySnapshots.value = {
    ...customEntrySnapshots.value,
    [route.id]: { node: { ...node }, metric: { ...metric } },
  }
}

function restoreCustomEntry(route: TopologyRouteConfig): boolean {
  const snapshot = customEntrySnapshots.value[route.id]
  if (!snapshot)
    return false
  route.nodes[0] = { ...snapshot.node }
  route.metrics[0] = { ...snapshot.metric }
  return true
}

function customEntryLabel(route: TopologyRouteConfig): string {
  return customEntrySnapshots.value[route.id]?.node.name.trim() || routeProbeLabel(route)
}

function hasCustomEntryOption(route: TopologyRouteConfig): boolean {
  return routeProbeValue(route) === CUSTOM_PROBE || Boolean(customEntrySnapshots.value[route.id])
}

function selectRouteProbe(route: TopologyRouteConfig, probeKey: string): void {
  if (!probeKey)
    return
  if (probeKey === CUSTOM_PROBE) {
    if (!restoreCustomEntry(route))
      return
    void planRouteTasksAndSave(route)
    return
  }
  if (routeProbeValue(route) === CUSTOM_PROBE)
    rememberCustomEntry(route)
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
  clearRouteProbeState(route.id)
  clearRouteTaskError(route.id)
  clearRouteTaskPlanning(route.id)
  const nextSnapshots = { ...customEntrySnapshots.value }
  delete nextSnapshots[route.id]
  customEntrySnapshots.value = nextSnapshots
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
    if (manager.dirty && !persistBlockingErrors.value.length) {
      await persistRoutes({
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
  if (!props.open || rematching.value || !manager.dirty || persistBlockingErrors.value.length)
    return
  // Another route may still be matching tasks. Don't toast an error; the
  // in-flight planner will persist the latest draft when it finishes.
  if (taskValidationPending.value)
    return
  await persistRoutes({ keepOpen: true, successMessage, quiet: true })
}

function findEndpoint(uuid: string) {
  return props.nodes.find(node => node.uuid === uuid)
    ?? manager.quickNodes.find(node => node.uuid === uuid)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function enqueuePersist<T>(work: () => Promise<T>): Promise<T> {
  const run = persistTail.then(work, work)
  persistTail = run.then(() => undefined, () => undefined)
  return run
}

async function persistRoutes(options: {
  keepOpen?: boolean
  successMessage?: string
  runId?: number
  ignoreBusy?: boolean
  quiet?: boolean
} = {}): Promise<'invalid' | 'saved' | 'changed' | 'cancelled'> {
  return enqueuePersist(async () => {
    if (!props.open)
      return 'cancelled'
    if (taskValidationPending.value && options.runId === undefined && !options.ignoreBusy) {
      if (!options.quiet)
        window.$message?.warning('正在验证 Ping 任务，请稍后再保存。')
      return 'invalid'
    }
    if (persistBlockingErrors.value.length) {
      if (!options.quiet)
        window.$message?.error('请先修正无效的线路配置。')
      return 'invalid'
    }
    if (!manager.dirty) {
      if (options.runId !== undefined && options.successMessage) {
        window.$message?.success(options.successMessage)
        return 'saved'
      }
      return 'cancelled'
    }
    const session = dialogSession
    const runId = options.runId ?? quickConfigurationRun
    const controller = new AbortController()
    const createdTaskIds = new Set<number>()
    let saveAttempted = false
    saveTaskController = controller
    persisting.value = true
    try {
      const persist = async (lockHeld = false) => {
        for (const route of manager.routes) {
          const pending = pendingRouteTasks.value[route.id]
          if (!pending)
            continue
          const source = findEndpoint(pending.sourceUuid)
          const target = findEndpoint(pending.targetUuid)
          if (!source || !target)
            throw new Error('待创建 Ping 任务的节点已变化，请重新选择线路。')
          const routeSource = resolveTopologyNode(props.nodes, route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
          const routeTarget = resolveTopologyNode(props.nodes, route.nodes[2]?.name ?? '', route.nodes[2]?.uuid ?? '')
          const plannedMetric = route.metrics[1]
          if (routeSource?.uuid !== pending.sourceUuid
            || routeTarget?.uuid !== pending.targetUuid
            || !plannedMetric?.live
            || plannedMetric.nodeName !== source.name
            || plannedMetric.taskFilter !== pending.taskName) {
            throw new Error('待创建 Ping 任务对应的线路段已变化，请重新选择。')
          }
          try {
            const ensured = await ensureTopologyPingTask(source, target, { probe: pending.probe, signal: controller.signal })
            if (ensured.created && Number.isInteger(ensured.task.id)) {
              sessionCreatedTaskIds.add(ensured.task.id!)
              persistTopologyCreatedTaskIds()
              createdTaskIds.add(ensured.task.id!)
            }
            if (runId !== quickConfigurationRun || session !== dialogSession || !props.open) {
              await cleanupCreatedTasks(createdTaskIds)
              return 'cancelled' as const
            }
            const metric = route.metrics[1]!
            metric.nodeName = source.name
            metric.taskFilter = ensured.task.name
            metric.live = true
            rememberTask(source.uuid, ensured.task.name)
            clearPendingRouteTask(route.id)
            clearRouteTaskError(route.id)
          }
          catch (error) {
            if (controller.signal.aborted)
              throw error
            routeTaskErrors.value = {
              ...routeTaskErrors.value,
              [route.id]: error instanceof Error ? error.message : '无法创建探测任务。',
            }
            continue
          }
        }
        if (runId !== quickConfigurationRun || session !== dialogSession || !props.open) {
          await cleanupCreatedTasks(createdTaskIds)
          return 'cancelled' as const
        }
        if (manager.routes.some(route => Boolean(pendingRouteTasks.value[route.id]))) {
          window.$message?.error('部分探测任务创建失败，未保存未完成的绑定。')
          return 'invalid' as const
        }
        if (createdTaskIds.size) {
          await manager.preflightSave()
          if (runId !== quickConfigurationRun || session !== dialogSession || !props.open) {
            await cleanupCreatedTasks(createdTaskIds)
            return 'cancelled' as const
          }
        }
        saveAttempted = true
        const saveResult = await manager.save({ lockHeld })
        if (saveResult === 'invalid') {
          saveAttempted = false
          await cleanupCreatedTasks(createdTaskIds)
          return saveResult
        }
        createdTaskIds.clear()
        return saveResult
      }
      const hasPendingTasks = manager.routes.some(route => Boolean(pendingRouteTasks.value[route.id]))
      const result = hasPendingTasks
        ? await manager.withSaveLock(async () => {
            await manager.preflightSave()
            return persist(true)
          })
        : await persist()
      if (result === 'cancelled' || session !== dialogSession || !props.open)
        return 'cancelled'
      if (result === 'saved') {
        await retireReplacedTasks()
        window.$message?.success(options.successMessage ?? '拓扑配置已保存。')
        if (!options.keepOpen)
          isOpen.value = false
      }
      else if (result === 'changed') {
        window.$message?.warning('提交时的配置已保存，当前修改尚未保存。')
      }
      return result
    }
    catch (error) {
      if (createdTaskIds.size && !saveAttempted) {
        await cleanupCreatedTasks(createdTaskIds)
      }
      else if (createdTaskIds.size) {
        try {
          await manager.preflightSave()
          await cleanupCreatedTasks(createdTaskIds)
        }
        catch {
          // Persistence is ambiguous after a write starts; keep tasks that may
          // already be referenced by the server-side topology snapshot.
        }
      }
      if (isAbortError(error) || session !== dialogSession || !props.open)
        return 'cancelled'
      window.$message?.error(error instanceof Error ? error.message : '拓扑保存失败。')
      return 'invalid'
    }
    finally {
      if (saveTaskController === controller)
        saveTaskController = null
      persisting.value = false
    }
  })
}

async function save(): Promise<void> {
  await persistRoutes()
}

function onQuickSourceChange(): void {
  const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
  if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName, quickSourceUuid.value, quickLandingUuid.value) >= 0)
    quickLandingUuid.value = ''
  if (!quickLandingUuid.value)
    syncQuickSelections(true)
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
    const latestLanding = manager.quickNodes.find(node => node.uuid === selectedLandingUuid)
    if (!latestSource || !latestLanding) {
      window.$message?.warning('节点已变化，请重新选择后添加。')
      return
    }
    if (latestSource.online === false || latestLanding.online === false) {
      window.$message?.warning('线路机或落地机已离线，请上线后再添加。')
      return
    }
    let sourceTasks = result.tasks
    const entry = await ensureTopologyEntryPingTask(latestSource, selectedProbeKey)
    if (runId !== quickConfigurationRun || !props.open)
      return
    if (entry) {
      if (entry.created && Number.isInteger(entry.task.id))
        rememberTopologyCreatedTaskId(entry.task.id!)
      rememberTask(latestSource.uuid, entry.task.name)
      sourceTasks = [...new Set([...sourceTasks, entry.task.name])]
    }
    const planned = await planWorkingHopTask(latestSource, latestLanding)
    if (runId !== quickConfigurationRun || !props.open)
      return
    if (!planned.needsCreation)
      rememberTask(latestSource.uuid, planned.task.name)
    const configured = manager.addQuickRoute(
      [...new Set([...sourceTasks, planned.task.name])],
      selectedSourceUuid,
      {
        landingUuid: selectedLandingUuid,
        hopTask: planned.task.name,
        probeKey: selectedProbeKey,
      },
    )
    if (!configured) {
      window.$message?.error('所选节点已变化，请重新选择后添加。')
      return
    }
    const nextPending = { ...pendingRouteTasks.value }
    if (planned.needsCreation) {
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
    if (configured.created) {
      quickLandingUuid.value = ''
      syncQuickSelections(true)
    }
    const persistResult = await persistRoutes({
      keepOpen: true,
      runId,
      successMessage: configured.created
        ? (planned.needsCreation ? '已添加线路并创建探测任务。' : '已添加并保存。')
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
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="拓扑管理"
    description="选入口、线路机和落地机即可。添加和修改都会自动保存，探测任务会自动创建或复用。"
    content-class="max-w-3xl"
  >
    <fieldset
      class="min-w-0 space-y-4"
      :disabled="managerBusy"
      :data-topology-ready="rematchDone ? 'true' : 'false'"
    >
      <div class="space-y-3 rounded-lg border border-border/60 bg-background/45 px-3 py-3">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="max-w-prose text-xs text-muted-foreground">
            入口只是线路图上的标签，例如北京电信或北京联通。实时数据由线路机发出 Ping。添加或修改线路都会立刻保存；入口探测会自动创建或把线路机加进已有的同名任务，第 2 段按落地机地址自动创建或复用。探测方式也会自动挑选，打不通会自动换一种。主题自己建的任务会记在配置里，关页后再开仍可安全清理。<br>
            新建线路只列出在线节点（需要当场验证探测）；下方已有线路可以选到离线节点，方便节点掉线后继续修改。没有公网 IP 的节点不能作为落地机。重名节点只要能选中就会按 UUID 绑定。
          </p>
          <Button
            size="sm"
            variant="outline"
            class="h-8"
            :disabled="managerBusy || !manager.routes.length"
            data-topology-recheck
            @click="recheckNow"
          >
            <Icon :icon="rematching ? 'tabler:loader-2' : 'tabler:refresh'" :class="rematching && 'animate-spin'" />
            重新检测
          </Button>
        </div>
        <div class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口探测
            <select
              v-model="quickProbeKey"
              :disabled="quickConfiguring"
              aria-label="添加线路入口探测"
              :class="selectClass"
            >
              <optgroup v-for="city in PROBE_CITIES" :key="city" :label="city">
                <option
                  v-for="option in TOPOLOGY_PROBE_OPTIONS.filter(item => item.city === city)"
                  :key="option.key"
                  :value="option.key"
                >
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              v-model="quickSourceUuid"
              :disabled="quickConfiguring"
              aria-label="添加线路线路机"
              :class="selectClass"
              @change="onQuickSourceChange"
            >
              <option v-if="!manager.quickNodes.length" value="">
                没有可用节点
              </option>
              <option
                v-for="option in manager.quickNodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'source').disabled"
              >
                {{ nodeOption(option, 'source').label }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
            <select
              v-model="quickLandingUuid"
              :disabled="quickConfiguring"
              aria-label="添加线路落地机"
              :class="selectClass"
            >
              <option value="">
                选择落地机
              </option>
              <option
                v-for="option in quickLandingOptions"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'landing').disabled"
              >
                {{ nodeOption(option, 'landing').label }}
              </option>
            </select>
          </label>
          <Button
            size="sm"
            class="h-9"
            :disabled="managerBusy || !manager.quickConfigurationAvailable || !manager.canAddRoute || !quickLandingUuid"
            :aria-busy="managerBusy"
            @click="addQuickRoute"
          >
            <Icon :icon="quickConfiguring ? 'tabler:loader-2' : 'tabler:plus'" :class="quickConfiguring && 'animate-spin'" />
            {{ quickConfiguring ? '添加中' : '添加线路' }}
          </Button>
        </div>
        <p v-if="quickTaskError" role="alert" class="text-xs text-destructive">
          {{ quickTaskError }}
        </p>
      </div>
      <span class="sr-only" aria-live="polite">{{ rematching ? '正在校正已有线路' : quickConfiguring ? '正在添加拓扑线路' : '' }}</span>

      <div v-if="validationErrors.length" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <div v-for="error in validationErrors" :key="error">
          {{ error }}
        </div>
      </div>

      <article
        v-for="(route, routeIndex) in manager.routes"
        :key="route.id"
        :data-topology-route-id="route.id"
        :data-topology-entry-probe="routeProbeValue(route)"
        :data-topology-entry-task="route.metrics[0]?.taskFilter || ''"
        :data-topology-hop-task="routeHopTask(route)"
        :data-topology-hop-pending="pendingRouteTasks[route.id] ? 'true' : 'false'"
        :data-topology-hop-probe="routeProbeStates[route.id] ? describeTopologyHopProbe(routeProbeStates[route.id]!.probe) : ''"
        :data-topology-hop-verdict="routeProbeStates[route.id]?.verdict ?? ''"
        class="rounded-xl border border-border/65 bg-background/40 p-3"
      >
        <header class="mb-2 flex items-center justify-between gap-3">
          <span class="text-sm font-semibold">线路 {{ routeIndex + 1 }}</span>
          <div class="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === 0" aria-label="上移线路" @click="moveRoute(routeIndex, -1)">
              <Icon icon="tabler:arrow-up" />
            </Button>
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === manager.routes.length - 1" aria-label="下移线路" @click="moveRoute(routeIndex, 1)">
              <Icon icon="tabler:arrow-down" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="删除线路" @click="removeRoute(routeIndex)">
              <Icon icon="tabler:trash" />
            </Button>
          </div>
        </header>

        <div class="grid items-end gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口
            <select
              :value="routeProbeValue(route)"
              :aria-label="`第 ${routeIndex + 1} 条线路入口探测`"
              :class="selectClass"
              @change="selectRouteProbe(route, ($event.target as HTMLSelectElement).value)"
            >
              <option v-if="hasCustomEntryOption(route)" :value="CUSTOM_PROBE">
                {{ customEntryLabel(route) }}
              </option>
              <optgroup v-for="city in PROBE_CITIES" :key="`${route.id}-${city}`" :label="city">
                <option
                  v-for="option in TOPOLOGY_PROBE_OPTIONS.filter(item => item.city === city)"
                  :key="option.key"
                  :value="option.key"
                >
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground sm:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              :value="route.nodes[1]?.uuid || route.nodes[1]?.name || ''"
              :aria-label="`第 ${routeIndex + 1} 条线路线路机`"
              :class="selectClass"
              @change="selectRouteNode(route, 1, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option
                v-for="option in props.nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'source', route.nodes[2]?.uuid, route.nodes[2]?.name).disabled"
              >
                {{ nodeOption(option, 'source', route.nodes[2]?.uuid, route.nodes[2]?.name).label }}
              </option>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground sm:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
            <select
              :value="route.nodes[2]?.uuid || route.nodes[2]?.name || ''"
              :aria-label="`第 ${routeIndex + 1} 条线路落地机`"
              :class="selectClass"
              @change="selectRouteNode(route, 2, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option
                v-for="option in props.nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'landing', route.nodes[1]?.uuid, route.nodes[1]?.name).disabled"
              >
                {{ nodeOption(option, 'landing', route.nodes[1]?.uuid, route.nodes[1]?.name).label }}
              </option>
            </select>
          </label>
        </div>
        <p
          v-if="routeEntryHint(route)"
          data-topology-entry-hint
          class="mt-2 text-[11px]"
          :class="routeEntryHintTone(route) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'"
        >
          {{ routeEntryHint(route) }}
        </p>
        <p
          v-if="routeHint(route)"
          data-topology-hop-hint
          class="mt-1 text-[11px]"
          :class="routeHintTone(route) ? 'text-destructive' : 'text-muted-foreground'"
        >
          {{ routeHint(route) }}
        </p>
      </article>

      <div v-if="!manager.routes.length" class="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        还没有线路。选入口、线路机和落地机后点击“添加线路”，会立即保存。
      </div>

      <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl" :aria-busy="managerBusy">
        <Button variant="outline" :disabled="managerBusy" @click="reset">
          恢复已保存配置
        </Button>
        <Button :disabled="managerBusy || taskValidationPending || !manager.dirty || persistBlockingErrors.length > 0" @click="save">
          <Icon :icon="manager.saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="manager.saving && 'animate-spin'" />
          {{ manager.saving ? '保存中' : '保存并应用' }}
        </Button>
      </footer>
    </fieldset>
  </AppDialog>
</template>
