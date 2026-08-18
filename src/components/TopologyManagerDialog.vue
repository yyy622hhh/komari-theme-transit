<script setup lang="ts">
import type { TopologyHopProbe } from '@/services/ping-task.service'
import type { HopTaskVerdict } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { Icon } from '@iconify/vue'
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { OPS_TOPOLOGY_HOP_PROBE, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { deleteTopologyPingTasks, describeTopologyHopProbe, ensureTopologyPingTask, loadAdminPingTaskNamesForNode, normalizeTopologyHopProbe } from '@/services/ping-task.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { applyTopologyProbeToRoute, findTopologyProbeKey, findUniqueTopologyNode, getTopologyRouteProbeKey, listUnusedQuickLandingUuids, nextQuickLandingUuid, shouldAutoApplyTopologyProbe, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const CUSTOM_PROBE = '__custom_probe__'
const DEFAULT_PROBE = TOPOLOGY_PROBE_OPTIONS[0]!.key
const PROBE_CITIES = [...new Set(TOPOLOGY_PROBE_OPTIONS.map(option => option.city))]
const manager = reactive(useTopologyManager(() => props.nodes))
const taskOptions = ref<Record<string, string[]>>({})
const taskErrors = ref<Record<string, string>>({})
const taskLoaded = ref<Record<string, boolean>>({})
interface TaskLoadResult { tasks: string[], error: string }
const taskRequests = new Map<string, Promise<TaskLoadResult>>()
const quickConfiguring = ref(false)
const rematching = ref(false)
const rematchDone = ref(false)
const quickSourceUuid = ref('')
const quickLandingUuid = ref('')
const quickProbeKey = ref(DEFAULT_PROBE)
interface RouteProbeState {
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  exhausted: boolean
  switchedFrom: TopologyHopProbe | null
  targetAddress: string
}
const pendingRouteTasks = ref<Record<number, { sourceUuid: string, targetUuid: string, taskName: string, probe: TopologyHopProbe }>>({})
const routeProbeStates = ref<Record<number, RouteProbeState>>({})
/** 新任务绑定并保存成功后可以清理掉的旧任务候选，按线路记录。 */
const routeRetiredTasks = ref<Record<number, Array<{ id: number, name: string }>>>({})
const sessionCreatedTaskIds = new Set<number>()
const HOP_PROBE_LADDER_TEXT = OPS_TOPOLOGY_HOP_PROBE_LADDER
  .map(rung => describeTopologyHopProbe(normalizeTopologyHopProbe(rung)))
  .join('、')
let recheckTimer: ReturnType<typeof setInterval> | null = null
const routeTaskPlanning = ref<Record<number, boolean>>({})
const routeTaskErrors = ref<Record<number, string>>({})
const routeTaskRuns = new Map<number, number>()
let quickConfigurationRun = 0
let dialogSession = 0
let persistTail: Promise<unknown> = Promise.resolve()
let saveTaskController: AbortController | null = null
const persisting = ref(false)

const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
const quickSourceName = computed(() => manager.quickNodes.find(node => node.uuid === quickSourceUuid.value)?.name ?? '')
const quickTaskError = computed(() => quickSourceUuid.value ? taskErrors.value[quickSourceUuid.value] ?? '' : '')
const taskBindingErrors = computed(() => manager.routes.flatMap((route, routeIndex) => route.metrics.flatMap((metric, metricIndex) => {
  if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
    return []
  const node = findUniqueTopologyNode(props.nodes, metric.nodeName)
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
  const node = findUniqueTopologyNode(props.nodes, metric.nodeName)
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
  const landingUuids = sources.map(node => node.uuid).filter((uuid): uuid is string => Boolean(uuid))
  quickLandingUuid.value = nextQuickLandingUuid(
    quickSourceUuid.value,
    quickLandingUuid.value,
    landingUuids,
    initialize,
    unusedQuickLandingUuids(),
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
    pendingRouteTasks.value = {}
    routeProbeStates.value = {}
    routeRetiredTasks.value = {}
    routeTaskPlanning.value = {}
    routeTaskErrors.value = {}
    routeTaskRuns.clear()
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

function cancelRouteTaskPlanning(): void {
  for (const [routeId, runId] of routeTaskRuns)
    routeTaskRuns.set(routeId, runId + 1)
  routeTaskPlanning.value = {}
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
    pendingRouteTasks.value = {}
    routeProbeStates.value = {}
    routeRetiredTasks.value = {}
    routeTaskPlanning.value = {}
    routeTaskErrors.value = {}
    routeTaskRuns.clear()
    await rematchOpenRoutes(session)
  })()
}

async function loadTasks(nodeName: string): Promise<TaskLoadResult> {
  const node = findUniqueTopologyNode(props.nodes, nodeName)
  if (!node && manager.isAmbiguousNodeName(nodeName))
    return { tasks: [], error: '节点名称重复，无法唯一读取 Ping 任务。' }
  if (!node)
    return { tasks: [], error: '' }
  const pending = taskRequests.get(node.uuid)
  if (pending)
    return pending
  if (!taskOptions.value[node.uuid])
    taskLoaded.value = { ...taskLoaded.value, [node.uuid]: false }
  taskErrors.value = { ...taskErrors.value, [node.uuid]: '' }

  const request = (async () => {
    try {
      const tasks = await loadAdminPingTaskNamesForNode(node.uuid)
      taskOptions.value = { ...taskOptions.value, [node.uuid]: tasks }
      taskLoaded.value = { ...taskLoaded.value, [node.uuid]: true }
      return { tasks, error: '' }
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : ''
      const message = detail.includes('登录状态已过期')
        ? detail
        : '无法读取 Ping 任务，请稍后重试。'
      taskErrors.value = {
        ...taskErrors.value,
        [node.uuid]: message,
      }
      return { tasks: [], error: message }
    }
    finally {
      taskRequests.delete(node.uuid)
      if (props.open && !rematching.value && !quickConfiguring.value && manager.dirty)
        void persistDraft('线路已保存。')
    }
  })()
  taskRequests.set(node.uuid, request)
  return request
}

function rememberTask(sourceUuid: string, taskName: string): void {
  if (!sourceUuid || !taskName)
    return
  taskOptions.value = {
    ...taskOptions.value,
    [sourceUuid]: [...new Set([...(taskOptions.value[sourceUuid] ?? []), taskName])],
  }
  taskLoaded.value = { ...taskLoaded.value, [sourceUuid]: true }
}

function reservedEntryNames(route?: TopologyRouteConfig): string[] {
  return props.nodes
    .map(node => node.name)
    .filter(name => name.trim().toLowerCase() !== route?.nodes[0]?.name.trim().toLowerCase())
}

function routeProbeValue(route: TopologyRouteConfig): string {
  return getTopologyRouteProbeKey(route) || CUSTOM_PROBE
}

function routeProbeLabel(route: TopologyRouteConfig): string {
  return route.nodes[0]?.name.trim() || '自定义入口'
}

function routeHopTask(route: TopologyRouteConfig): string {
  return pendingRouteTasks.value[route.id]?.taskName || route.metrics[1]?.taskFilter.trim() || ''
}

function routeHint(route: TopologyRouteConfig): string {
  if (routeTaskPlanning.value[route.id])
    return '正在自动挑选可用的探测方式…'
  if (routeTaskErrors.value[route.id])
    return routeTaskErrors.value[route.id] ?? ''
  const source = route.nodes[1]?.name.trim() ?? ''
  const landing = route.nodes[2]?.name.trim() ?? ''
  if (!source)
    return '请选择线路机。'
  if (!landing)
    return '请选择落地机。'
  const state = routeProbeStates.value[route.id]
  if (!state)
    return ''
  const probeText = describeTopologyHopProbe(state.probe)
  if (state.exhausted)
    return `${HOP_PROBE_LADDER_TEXT} 都探测不通；落地机上报地址 ${state.targetAddress} 可能不是真实入站地址。`
  if (state.switchedFrom)
    return `${describeTopologyHopProbe(state.switchedFrom)} 探测不通，已自动改用 ${probeText}。`
  if (pendingRouteTasks.value[route.id])
    return `正在按 ${probeText} 自动创建探测任务。`
  if (state.verdict === 'healthy')
    return `探测方式：${probeText} · 正常`
  if (state.verdict === 'dead')
    return `探测方式：${probeText} · 没有成功响应，正在自动换用其它方式。`
  return `探测方式：${probeText} · 正在等待首批采样`
}

function routeHintTone(route: TopologyRouteConfig): boolean {
  return Boolean(routeTaskErrors.value[route.id] || routeProbeStates.value[route.id]?.exhausted)
}

function clearRouteProbeState(routeId: number): void {
  if (routeRetiredTasks.value[routeId]) {
    const nextRetired = { ...routeRetiredTasks.value }
    delete nextRetired[routeId]
    routeRetiredTasks.value = nextRetired
  }
  if (!routeProbeStates.value[routeId])
    return
  const next = { ...routeProbeStates.value }
  delete next[routeId]
  routeProbeStates.value = next
}

function rememberRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>): void {
  const retirable = tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
  const next = { ...routeRetiredTasks.value }
  if (retirable.length)
    next[routeId] = retirable
  else
    delete next[routeId]
  routeRetiredTasks.value = next
}

/**
 * 清理本页面会话中由主题创建、随后被换掉的旧探测任务。
 *
 * 名称不是所有权证明：既有任务即使恰好使用 Transit 命名也不能删除。这里只接受
 * ensure 明确返回 created=true 后记录的 ID，并在配置保存成功后再次确认没有线路绑定。
 */
async function retireReplacedTasks(): Promise<void> {
  const boundNames = new Set(manager.routes.flatMap(route => route.metrics
    .filter(metric => metric.live)
    .map(metric => metric.taskFilter.trim())))
  const entries = Object.entries(routeRetiredTasks.value)
  if (!entries.length)
    return
  routeRetiredTasks.value = {}
  const ids = [...new Set(entries.flatMap(([, tasks]) => tasks
    .filter(task => sessionCreatedTaskIds.has(task.id) && !boundNames.has(task.name.trim()))
    .map(task => task.id)))]
  if (ids.length && await deleteTopologyPingTasks(ids)) {
    for (const id of ids)
      sessionCreatedTaskIds.delete(id)
  }
}

async function planRouteTasks(route: TopologyRouteConfig): Promise<void> {
  const runId = (routeTaskRuns.get(route.id) ?? 0) + 1
  routeTaskRuns.set(route.id, runId)
  clearPendingRouteTask(route.id)
  routeTaskErrors.value = { ...routeTaskErrors.value, [route.id]: '' }
  const source = findUniqueTopologyNode(props.nodes, route.nodes[1]?.name ?? '')
  const landing = findUniqueTopologyNode(props.nodes, route.nodes[2]?.name ?? '')
  const firstMetric = route.metrics[0]
  const secondMetric = route.metrics[1]
  if (!source) {
    const nextPlanning = { ...routeTaskPlanning.value }
    delete nextPlanning[route.id]
    routeTaskPlanning.value = nextPlanning
    return
  }

  routeTaskPlanning.value = { ...routeTaskPlanning.value, [route.id]: true }
  try {
    const loaded = await loadTasks(source.name)
    if (routeTaskRuns.get(route.id) !== runId || !props.open || !manager.routes.includes(route))
      return
    if (loaded.error)
      throw new Error(loaded.error)

    const probeKey = getTopologyRouteProbeKey(route)
    if (probeKey && shouldAutoApplyTopologyProbe(route)) {
      applyTopologyProbeToRoute(route, probeKey, source.name, loaded.tasks, reservedEntryNames(route))
    }
    else if (firstMetric?.live && !firstMetric.taskFilter.trim()) {
      const matchingEntryTasks = loaded.tasks.filter(task => findTopologyProbeKey(task) === findTopologyProbeKey(route.nodes[0]?.name ?? ''))
      if (matchingEntryTasks.length === 1)
        firstMetric.taskFilter = matchingEntryTasks[0]!
    }

    if (!landing) {
      clearRouteProbeState(route.id)
      if (secondMetric) {
        secondMetric.live = false
        secondMetric.nodeName = ''
        secondMetric.taskFilter = ''
      }
      return
    }
    if (!secondMetric)
      return
    const planned = await planWorkingHopTask(source, landing, secondMetric.taskFilter)
    if (routeTaskRuns.get(route.id) !== runId || !props.open || !manager.routes.includes(route))
      return
    secondMetric.live = true
    secondMetric.nodeName = source.name
    secondMetric.taskFilter = planned.task.name
    routeProbeStates.value = {
      ...routeProbeStates.value,
      [route.id]: {
        probe: planned.probe,
        verdict: planned.verdict,
        exhausted: planned.exhausted,
        switchedFrom: planned.switchedFrom,
        targetAddress: planned.targetAddress,
      },
    }
    rememberRetiredTasks(route.id, planned.retiredTasks)
    if (planned.needsCreation) {
      pendingRouteTasks.value = {
        ...pendingRouteTasks.value,
        [route.id]: {
          sourceUuid: source.uuid,
          targetUuid: landing.uuid,
          taskName: planned.task.name,
          probe: planned.probe,
        },
      }
    }
    else {
      rememberTask(source.uuid, planned.task.name)
    }
  }
  catch (error) {
    if (routeTaskRuns.get(route.id) === runId && props.open && manager.routes.includes(route)) {
      routeTaskErrors.value = {
        ...routeTaskErrors.value,
        [route.id]: error instanceof Error ? error.message : '无法按所选节点匹配 Ping 任务。',
      }
    }
  }
  finally {
    if (routeTaskRuns.get(route.id) === runId)
      routeTaskPlanning.value = { ...routeTaskPlanning.value, [route.id]: false }
  }
}

function selectRouteNode(route: TopologyRouteConfig, index: number, nodeName: string): void {
  if (index > 0) {
    clearPendingRouteTask(route.id)
    routeTaskRuns.set(route.id, (routeTaskRuns.get(route.id) ?? 0) + 1)
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
  if (!probeKey || probeKey === CUSTOM_PROBE)
    return
  const sourceName = route.nodes[1]?.name.trim() ?? ''
  const source = findUniqueTopologyNode(props.nodes, sourceName)
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
  routeTaskRuns.set(route.id, (routeTaskRuns.get(route.id) ?? 0) + 1)
  clearPendingRouteTask(route.id)
  clearRouteProbeState(route.id)
  clearRouteTaskError(route.id)
  const nextPlanning = { ...routeTaskPlanning.value }
  delete nextPlanning[route.id]
  routeTaskPlanning.value = nextPlanning
  manager.removeRoute(index)
  void persistDraft('线路已删除。')
}

function moveRoute(index: number, offset: -1 | 1): void {
  manager.moveRoute(index, offset)
  void persistDraft('线路顺序已保存。')
}

function clearPendingRouteTask(routeId: number): void {
  if (!pendingRouteTasks.value[routeId])
    return
  const nextPending = { ...pendingRouteTasks.value }
  delete nextPending[routeId]
  pendingRouteTasks.value = nextPending
}

function clearRouteTaskError(routeId: number): void {
  if (!routeTaskErrors.value[routeId])
    return
  const nextErrors = { ...routeTaskErrors.value }
  delete nextErrors[routeId]
  routeTaskErrors.value = nextErrors
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
          const routeSource = findUniqueTopologyNode(props.nodes, route.nodes[1]?.name ?? '')
          const routeTarget = findUniqueTopologyNode(props.nodes, route.nodes[2]?.name ?? '')
          const plannedMetric = route.metrics[1]
          if (routeSource?.uuid !== pending.sourceUuid
            || routeTarget?.uuid !== pending.targetUuid
            || !plannedMetric?.live
            || plannedMetric.nodeName !== source.name
            || plannedMetric.taskFilter !== pending.taskName) {
            throw new Error('待创建 Ping 任务对应的线路段已变化，请重新选择。')
          }
          const ensured = await ensureTopologyPingTask(source, target, { probe: pending.probe, signal: controller.signal })
          if (runId !== quickConfigurationRun || session !== dialogSession || !props.open)
            return 'cancelled' as const
          if (ensured.created && Number.isInteger(ensured.task.id))
            sessionCreatedTaskIds.add(ensured.task.id!)
          const metric = route.metrics[1]!
          metric.nodeName = source.name
          metric.taskFilter = ensured.task.name
          metric.live = true
          rememberTask(source.uuid, ensured.task.name)
          const nextPending = { ...pendingRouteTasks.value }
          delete nextPending[route.id]
          pendingRouteTasks.value = nextPending
        }
        if (runId !== quickConfigurationRun || session !== dialogSession || !props.open)
          return 'cancelled' as const
        return manager.save({ lockHeld })
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
  if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName) >= 0)
    quickLandingUuid.value = ''
  if (!quickLandingUuid.value)
    syncQuickSelections(true)
  if (quickSourceName.value)
    void loadTasks(quickSourceName.value)
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
  if (!quickLandingUuid.value) {
    window.$message?.error('请选择落地机。')
    return
  }

  const runId = ++quickConfigurationRun
  const selectedSourceUuid = source.uuid
  const selectedLandingUuid = quickLandingUuid.value
  const selectedProbeKey = quickProbeKey.value
  quickConfiguring.value = true
  try {
    const result = await loadTasks(source.name)
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
    const planned = await planWorkingHopTask(latestSource, latestLanding)
    if (runId !== quickConfigurationRun || !props.open)
      return
    if (!planned.needsCreation)
      rememberTask(latestSource.uuid, planned.task.name)
    const configured = manager.addQuickRoute(
      [...new Set([...result.tasks, planned.task.name])],
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

function nodeOptionDisabled(optionName: string, otherName = ''): boolean {
  return manager.isAmbiguousNodeName(optionName) || Boolean(otherName && optionName === otherName)
}

function nodeOptionLabel(optionName: string): string {
  return manager.isAmbiguousNodeName(optionName) ? `${optionName}（重名，不可用）` : optionName
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
            入口只是线路图上的标签，例如北京电信或北京联通。实时数据由线路机发出 Ping。添加或修改线路都会立刻保存，探测任务按落地机地址自动创建或复用；探测方式也会自动挑选，打不通会自动换一种。本次管理会话创建后又被换下的任务会安全清理。
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
              <option v-for="option in manager.quickNodes" :key="option.uuid" :value="option.uuid">
                {{ option.name }}
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
              <option v-for="option in quickLandingOptions" :key="option.uuid" :value="option.uuid">
                {{ option.name }}
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
              <option v-if="routeProbeValue(route) === CUSTOM_PROBE" :value="CUSTOM_PROBE">
                {{ routeProbeLabel(route) }}
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
              :value="route.nodes[1]?.name ?? ''"
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
                :value="option.name"
                :disabled="nodeOptionDisabled(option.name, route.nodes[2]?.name)"
              >
                {{ nodeOptionLabel(option.name) }}
              </option>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground sm:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
            <select
              :value="route.nodes[2]?.name ?? ''"
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
                :value="option.name"
                :disabled="nodeOptionDisabled(option.name, route.nodes[1]?.name)"
              >
                {{ nodeOptionLabel(option.name) }}
              </option>
            </select>
          </label>
        </div>
        <p
          v-if="routeHint(route)"
          data-topology-hop-hint
          class="mt-2 text-[11px]"
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
