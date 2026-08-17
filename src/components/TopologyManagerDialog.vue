<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { Icon } from '@iconify/vue'
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { ensureTopologyPingTask, loadAdminPingTaskNamesForNode, planTopologyPingTask } from '@/services/ping-task.service'
import { findTopologyProbeKey, findUniqueTopologyNode, listQuickTopologyProbeTasks, listUnusedQuickLandingUuids, nextQuickLandingUuid, pickQuickTopologyTaskName, TOPOLOGY_LIMITS } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const QUICK_ENTRY_AUTO = '__auto_entry__'
const manager = reactive(useTopologyManager(() => props.nodes))
const taskOptions = ref<Record<string, string[]>>({})
const taskLoading = ref<Record<string, boolean>>({})
const taskErrors = ref<Record<string, string>>({})
const taskLoaded = ref<Record<string, boolean>>({})
interface TaskLoadResult { tasks: string[], error: string }
const taskRequests = new Map<string, Promise<TaskLoadResult>>()
const quickConfiguring = ref(false)
const quickSourceUuid = ref('')
const quickLandingUuid = ref('')
const quickEntryTask = ref(QUICK_ENTRY_AUTO)
const pendingRouteTasks = ref<Record<number, { sourceUuid: string, targetUuid: string, taskName: string }>>({})
const routeTaskPlanning = ref<Record<number, boolean>>({})
const routeTaskErrors = ref<Record<number, string>>({})
const routeTaskRuns = new Map<number, number>()
let quickConfigurationRun = 0
let dialogSession = 0
let saveTaskController: AbortController | null = null

const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
const quickSourceName = computed(() => manager.quickNodes.find(node => node.uuid === quickSourceUuid.value)?.name ?? '')
const quickEntryTaskOptions = computed(() => listQuickTopologyProbeTasks(nodeTasks(quickSourceName.value)))
const quickTaskError = computed(() => quickSourceUuid.value ? taskErrors.value[quickSourceUuid.value] ?? '' : '')
const taskBindingErrors = computed(() => manager.routes.flatMap((route, routeIndex) => route.metrics.flatMap((metric, metricIndex) => {
  if (!metric.live || !metric.nodeName.trim() || !metric.taskFilter.trim())
    return []
  const node = findUniqueTopologyNode(props.nodes, metric.nodeName)
  if (!node) {
    return [`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段探测来源“${metric.nodeName}”不存在或名称重复`]
  }
  if (taskErrors.value[node.uuid])
    return [`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段无法验证 Ping 任务：${taskErrors.value[node.uuid]}`]
  if (!taskLoaded.value[node.uuid])
    return []
  const pending = metricIndex === 1 ? pendingRouteTasks.value[route.id] : undefined
  if (pending?.sourceUuid === node.uuid && pending.taskName === metric.taskFilter)
    return []
  return (taskOptions.value[node.uuid] ?? []).includes(metric.taskFilter)
    ? []
    : [`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段任务“${metric.taskFilter}”未分配给探测来源“${metric.nodeName}”`]
})))
const validationErrors = computed(() => [
  ...manager.validationErrors,
  ...taskBindingErrors.value,
  ...Object.entries(routeTaskErrors.value).filter(([, error]) => Boolean(error)).map(([routeId, error]) => {
    const routeIndex = manager.routes.findIndex(route => route.id === Number(routeId))
    return routeIndex >= 0 ? `第 ${routeIndex + 1} 条线路：${error}` : error
  }),
])
const taskValidationPending = computed(() => Object.values(routeTaskPlanning.value).some(Boolean) || manager.routes.some(route => route.metrics.some((metric) => {
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
  if (value) {
    manager.reset()
    pendingRouteTasks.value = {}
    routeTaskPlanning.value = {}
    routeTaskErrors.value = {}
    routeTaskRuns.clear()
    quickEntryTask.value = QUICK_ENTRY_AUTO
    syncQuickSelections(true)
    const sourceNames = [
      ...manager.routes.flatMap(route => route.metrics.map(metric => metric.nodeName)),
      quickSourceName.value,
    ].filter(Boolean)
    void Promise.all(Array.from(new Set(sourceNames), loadTasks))
  }
  else {
    cancelQuickConfiguration()
    cancelRouteTaskPlanning()
  }
}, { immediate: true })

watch(() => manager.quickNodes.map(node => node.uuid).join('|'), () => {
  if (props.open)
    syncQuickSelections()
})

onScopeDispose(() => {
  dialogSession += 1
  cancelQuickConfiguration()
  cancelRouteTaskPlanning()
})

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
  manager.reset()
  pendingRouteTasks.value = {}
  routeTaskPlanning.value = {}
  routeTaskErrors.value = {}
  routeTaskRuns.clear()
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
  taskLoading.value = { ...taskLoading.value, [node.uuid]: true }
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
      taskLoading.value = { ...taskLoading.value, [node.uuid]: false }
      taskRequests.delete(node.uuid)
    }
  })()
  taskRequests.set(node.uuid, request)
  return request
}

function nodeTasks(nodeName: string): string[] {
  const node = findUniqueTopologyNode(props.nodes, nodeName)
  return node ? taskOptions.value[node.uuid] ?? [] : []
}

function nodeTaskState(nodeName: string): { uuid: string, loading: boolean, error: string } {
  const uuid = findUniqueTopologyNode(props.nodes, nodeName)?.uuid ?? ''
  return {
    uuid,
    loading: Boolean(uuid && taskLoading.value[uuid]),
    error: manager.isAmbiguousNodeName(nodeName)
      ? '节点名称重复，无法唯一读取 Ping 任务。'
      : uuid ? taskErrors.value[uuid] ?? '' : '',
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

    if (firstMetric?.live && !firstMetric.taskFilter.trim()) {
      const probeKey = findTopologyProbeKey(route.nodes[0]?.name ?? '')
      const matchingEntryTasks = probeKey
        ? loaded.tasks.filter(task => findTopologyProbeKey(task) === probeKey)
        : []
      if (matchingEntryTasks.length === 1)
        firstMetric.taskFilter = matchingEntryTasks[0]!
    }

    if (!landing || !secondMetric?.live)
      return
    const planned = await planTopologyPingTask(source, landing)
    if (routeTaskRuns.get(route.id) !== runId || !props.open || !manager.routes.includes(route))
      return
    secondMetric.nodeName = source.name
    secondMetric.taskFilter = planned.task.name
    if (planned.needsCreation) {
      pendingRouteTasks.value = {
        ...pendingRouteTasks.value,
        [route.id]: {
          sourceUuid: source.uuid,
          targetUuid: landing.uuid,
          taskName: planned.task.name,
        },
      }
    }
    else {
      taskOptions.value = {
        ...taskOptions.value,
        [source.uuid]: [...new Set([...(taskOptions.value[source.uuid] ?? []), planned.task.name])],
      }
      taskLoaded.value = { ...taskLoaded.value, [source.uuid]: true }
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
  for (const metric of route.metrics) {
    if (metric.live && metric.nodeName === nodeName)
      void loadTasks(nodeName)
  }
  if (index > 0)
    void planRouteTasks(route)
}

function removeRoute(index: number): void {
  const route = manager.routes[index]
  if (!route)
    return
  routeTaskRuns.set(route.id, (routeTaskRuns.get(route.id) ?? 0) + 1)
  clearPendingRouteTask(route.id)
  clearRouteTaskError(route.id)
  const nextPlanning = { ...routeTaskPlanning.value }
  delete nextPlanning[route.id]
  routeTaskPlanning.value = nextPlanning
  manager.removeRoute(index)
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

function cancelRouteTaskPlan(routeId: number): void {
  routeTaskRuns.set(routeId, (routeTaskRuns.get(routeId) ?? 0) + 1)
  const nextPlanning = { ...routeTaskPlanning.value }
  delete nextPlanning[routeId]
  routeTaskPlanning.value = nextPlanning
}

function selectMetricSource(route: TopologyRouteConfig, metric: TopologyRouteConfig['metrics'][number], nodeName: string): void {
  cancelRouteTaskPlan(route.id)
  clearPendingRouteTask(route.id)
  clearRouteTaskError(route.id)
  manager.selectMetricSource(metric, nodeName)
  void loadTasks(metric.nodeName)
}

function selectMetricTask(route: TopologyRouteConfig, metric: TopologyRouteConfig['metrics'][number], taskName: string): void {
  cancelRouteTaskPlan(route.id)
  clearPendingRouteTask(route.id)
  clearRouteTaskError(route.id)
  metric.taskFilter = taskName
}

function setMetricMode(route: TopologyRouteConfig, metric: TopologyRouteConfig['metrics'][number], live: boolean): void {
  cancelRouteTaskPlan(route.id)
  clearPendingRouteTask(route.id)
  clearRouteTaskError(route.id)
  manager.setMetricMode(metric, live)
}

async function save(): Promise<void> {
  if (taskValidationPending.value) {
    window.$message?.warning('正在验证 Ping 任务，请稍后再保存。')
    return
  }
  if (validationErrors.value.length) {
    window.$message?.error('请先修正无效的 Ping 任务绑定。')
    return
  }
  const session = dialogSession
  const runId = ++quickConfigurationRun
  const controller = new AbortController()
  saveTaskController?.abort()
  saveTaskController = controller
  quickConfiguring.value = true
  try {
    const persist = async (lockHeld = false) => {
      for (const route of manager.routes) {
        const pending = pendingRouteTasks.value[route.id]
        if (!pending)
          continue
        const source = manager.quickNodes.find(node => node.uuid === pending.sourceUuid)
        const target = manager.quickNodes.find(node => node.uuid === pending.targetUuid)
        if (!source || !target)
          throw new Error('待创建 Ping 任务的节点已变化，请重新校正线路。')
        const routeSource = findUniqueTopologyNode(props.nodes, route.nodes[1]?.name ?? '')
        const routeTarget = findUniqueTopologyNode(props.nodes, route.nodes[2]?.name ?? '')
        const plannedMetric = route.metrics[1]
        if (routeSource?.uuid !== pending.sourceUuid
          || routeTarget?.uuid !== pending.targetUuid
          || !plannedMetric?.live
          || plannedMetric.nodeName !== source.name
          || plannedMetric.taskFilter !== pending.taskName) {
          throw new Error('待创建 Ping 任务对应的线路段已变化，请重新校正。')
        }
        const ensured = await ensureTopologyPingTask(source, target, controller.signal)
        if (runId !== quickConfigurationRun || session !== dialogSession || !props.open)
          return 'cancelled' as const
        const metric = route.metrics[1]!
        metric.nodeName = source.name
        metric.taskFilter = ensured.task.name
        metric.live = true
        taskOptions.value = {
          ...taskOptions.value,
          [source.uuid]: [...new Set([...(taskOptions.value[source.uuid] ?? []), ensured.task.name])],
        }
        taskLoaded.value = { ...taskLoaded.value, [source.uuid]: true }
        const nextPending = { ...pendingRouteTasks.value }
        delete nextPending[route.id]
        pendingRouteTasks.value = nextPending
      }
      return manager.save({ lockHeld })
    }
    const hasPendingTasks = manager.routes.some(route => Boolean(pendingRouteTasks.value[route.id]))
    const result = hasPendingTasks
      ? await manager.withSaveLock(async () => {
          await manager.preflightSave()
          return persist(true)
        })
      : await persist()
    if (result === 'cancelled')
      return
    if (session !== dialogSession || !props.open) {
      if (props.open)
        manager.reset()
      return
    }
    if (result === 'saved') {
      window.$message?.success('拓扑配置已保存。')
      isOpen.value = false
    }
    else if (result === 'changed') {
      window.$message?.warning('提交时的配置已保存，当前修改尚未保存。')
    }
  }
  catch (error) {
    if (session === dialogSession && props.open)
      window.$message?.error(error instanceof Error ? error.message : '拓扑保存失败。')
  }
  finally {
    if (saveTaskController === controller)
      saveTaskController = null
    if (runId === quickConfigurationRun)
      quickConfiguring.value = false
  }
}

function onQuickSourceChange(): void {
  const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
  if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName) >= 0)
    quickLandingUuid.value = ''
  if (!quickLandingUuid.value)
    syncQuickSelections(true)
  if (quickEntryTask.value !== QUICK_ENTRY_AUTO && quickEntryTask.value && !quickEntryTaskOptions.value.includes(quickEntryTask.value))
    quickEntryTask.value = QUICK_ENTRY_AUTO
  if (quickSourceName.value)
    void loadTasks(quickSourceName.value)
}

function focusTopologyRoute(routeId: number): void {
  const routeElement = document.querySelector<HTMLElement>(`[data-topology-route-id="${routeId}"]`)
  routeElement?.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true })
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
  const selectedEntryTask = quickEntryTask.value
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
    if (!latestSource || (selectedLandingUuid && !latestLanding)) {
      window.$message?.warning('节点已变化，请重新选择后生成。')
      return
    }
    const probeTasks = listQuickTopologyProbeTasks(result.tasks)
    const entryTask = selectedEntryTask === QUICK_ENTRY_AUTO
      ? pickQuickTopologyTaskName(result.tasks) || (probeTasks.length === 1 ? probeTasks[0]! : '')
      : selectedEntryTask
    if (entryTask && !result.tasks.includes(entryTask)) {
      window.$message?.error('入口探测任务已变化，请重新选择。')
      return
    }
    let hopTask = ''
    let plannedTask = false
    if (latestLanding) {
      const planned = await planTopologyPingTask(latestSource, latestLanding)
      if (runId !== quickConfigurationRun || !props.open)
        return
      hopTask = planned.task.name
      plannedTask = planned.needsCreation
      if (!plannedTask) {
        taskOptions.value = {
          ...taskOptions.value,
          [latestSource.uuid]: [...new Set([...(taskOptions.value[latestSource.uuid] ?? []), hopTask])],
        }
        taskLoaded.value = { ...taskLoaded.value, [latestSource.uuid]: true }
      }
    }
    const configured = manager.addQuickRoute(
      [...new Set([...result.tasks, ...(hopTask ? [hopTask] : [])])],
      selectedSourceUuid,
      {
        landingUuid: selectedLandingUuid || null,
        entryTask,
        hopTask,
      },
    )
    if (!configured) {
      window.$message?.error('所选节点已变化，请重新选择后生成。')
      return
    }
    const nextPending = { ...pendingRouteTasks.value }
    if (plannedTask && latestLanding) {
      nextPending[configured.route.id] = {
        sourceUuid: latestSource.uuid,
        targetUuid: latestLanding.uuid,
        taskName: hopTask,
      }
    }
    else {
      delete nextPending[configured.route.id]
    }
    pendingRouteTasks.value = nextPending
    if (selectedLandingUuid && configured.created) {
      quickLandingUuid.value = ''
      syncQuickSelections(true)
    }
    await nextTick()
    setTimeout(() => {
      if (runId === quickConfigurationRun && props.open)
        focusTopologyRoute(configured.route.id)
    })
    const hopBound = Boolean(configured.route.nodes[2]?.name.trim() && configured.route.metrics[1]?.live && configured.route.metrics[1]?.taskFilter)
    let successMessage = '已生成拓扑草稿。第 2 段未自动绑定，请在下方选择线路机上的 Ping 任务。'
    if (plannedTask)
      successMessage = '已生成线路；保存时会自动创建并绑定目标 Ping 任务。'
    else if (!configured.created)
      successMessage = '已按节点地址校正现有线路任务，确认后保存。'
    else if (hopBound || !configured.route.nodes[2]?.name.trim())
      successMessage = '已生成拓扑草稿，确认后保存。'
    window.$message?.success(successMessage)
  }
  catch (error) {
    if (runId === quickConfigurationRun && props.open)
      window.$message?.error(error instanceof Error ? error.message : '拓扑快速生成失败。')
  }
  finally {
    if (runId === quickConfigurationRun)
      quickConfiguring.value = false
  }
}

async function syncAllRouteTasks(): Promise<void> {
  if (quickConfiguring.value || !manager.routes.length)
    return
  const runId = ++quickConfigurationRun
  quickConfiguring.value = true
  let plannedCount = 0
  const draftRoutes = JSON.parse(JSON.stringify(manager.routes)) as TopologyRouteConfig[]
  const draftPending = { ...pendingRouteTasks.value }
  try {
    for (const [routeIndex, route] of draftRoutes.entries()) {
      const source = findUniqueTopologyNode(props.nodes, route.nodes[1]?.name ?? '')
      if (!source)
        throw new Error(`第 ${routeIndex + 1} 条线路的线路机不存在或名称重复。`)
      const loaded = await loadTasks(source.name)
      if (runId !== quickConfigurationRun || !props.open)
        return
      if (loaded.error)
        throw new Error(loaded.error)

      const firstMetric = route.metrics[0]
      if (firstMetric?.live) {
        const probeKey = findTopologyProbeKey(route.nodes[0]?.name ?? '', firstMetric.taskFilter)
        const matchingEntryTasks = probeKey
          ? loaded.tasks.filter(task => findTopologyProbeKey(task) === probeKey)
          : []
        const entryTask = loaded.tasks.includes(firstMetric.taskFilter)
          ? firstMetric.taskFilter
          : matchingEntryTasks.length === 1 ? matchingEntryTasks[0]! : ''
        if (!entryTask)
          throw new Error(`第 ${routeIndex + 1} 条线路找不到与入口匹配的 Ping 任务。`)
        route.metrics[0] = {
          live: true,
          nodeName: source.name,
          taskFilter: entryTask,
          fallbackLatency: firstMetric.fallbackLatency,
          fallbackLoss: firstMetric.fallbackLoss,
        }
      }

      const landing = findUniqueTopologyNode(props.nodes, route.nodes[2]?.name ?? '')
      if (!route.nodes[2]?.name.trim())
        continue
      const secondMetric = route.metrics[1]
      if (!secondMetric?.live)
        continue
      if (!landing)
        throw new Error(`第 ${routeIndex + 1} 条线路的落地机不存在或名称重复。`)
      const planned = await planTopologyPingTask(source, landing)
      if (runId !== quickConfigurationRun || !props.open)
        return
      if (planned.needsCreation) {
        plannedCount += 1
      }
      else {
        taskOptions.value = {
          ...taskOptions.value,
          [source.uuid]: [...new Set([...(taskOptions.value[source.uuid] ?? []), planned.task.name])],
        }
        taskLoaded.value = { ...taskLoaded.value, [source.uuid]: true }
      }
      route.metrics[1] = {
        live: true,
        nodeName: source.name,
        taskFilter: planned.task.name,
        fallbackLatency: secondMetric?.fallbackLatency ?? null,
        fallbackLoss: secondMetric?.fallbackLoss ?? null,
      }
      if (planned.needsCreation) {
        draftPending[route.id] = {
          sourceUuid: source.uuid,
          targetUuid: landing.uuid,
          taskName: planned.task.name,
        }
      }
      else {
        delete draftPending[route.id]
      }
    }
    manager.routes.splice(0, manager.routes.length, ...draftRoutes)
    pendingRouteTasks.value = draftPending
    window.$message?.success(plannedCount
      ? `已校正全部线路；保存时会创建 ${plannedCount} 个缺失任务。`
      : '已按节点地址校正全部线路任务；确认后保存。')
  }
  catch (error) {
    if (runId === quickConfigurationRun && props.open)
      window.$message?.error(error instanceof Error ? error.message : '线路任务校正失败。')
  }
  finally {
    if (runId === quickConfigurationRun)
      quickConfiguring.value = false
  }
}

function updateFallback(metric: { fallbackLatency: number | null, fallbackLoss: number | null }, key: 'fallbackLatency' | 'fallbackLoss', event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  const value = Number.parseFloat(raw)
  metric[key] = raw && Number.isFinite(value) ? value : null
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="拓扑管理"
    description="选择线路机和落地机后快速生成，或手动编辑每一段的实时 Ping 任务和静态基线。"
    content-class="max-w-6xl"
  >
    <fieldset class="min-w-0 space-y-4" :disabled="manager.saving || quickConfiguring">
      <div class="space-y-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-xs text-muted-foreground">
            选择线路机和可选落地机后快速生成。实时数据由线路机发出 Ping；图画成入口 → 线路机，不等于入口网络正向打过来。修改会保存到 Komari 主题设置。
          </div>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="quickConfiguring || !manager.routes.length" @click="syncAllRouteTasks">
              <Icon icon="tabler:refresh" />校正全部任务
            </Button>
            <Button size="sm" variant="outline" :disabled="quickConfiguring || !manager.quickConfigurationAvailable" :aria-busy="quickConfiguring" @click="addQuickRoute">
              <Icon :icon="quickConfiguring ? 'tabler:loader-2' : 'tabler:sparkles'" :class="quickConfiguring && 'animate-spin'" />
              {{ quickConfiguring ? '生成中' : '快速生成' }}
            </Button>
            <Button size="sm" variant="outline" :disabled="quickConfiguring || !manager.canAddRoute" @click="manager.addRoute">
              <Icon icon="tabler:plus" />添加线路
            </Button>
          </div>
        </div>
        <div v-if="manager.quickNodes.length" class="grid gap-2 sm:grid-cols-3">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              v-model="quickSourceUuid"
              :disabled="quickConfiguring"
              aria-label="快速生成线路机"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
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
            入口探测
            <select
              v-model="quickEntryTask"
              :disabled="quickConfiguring"
              aria-label="快速生成入口探测任务"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option :value="QUICK_ENTRY_AUTO">
                自动选择运营商任务
              </option>
              <option value="">
                不绑定，使用静态基线
              </option>
              <option v-for="task in quickEntryTaskOptions" :key="task" :value="task">
                {{ task }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机（可选）
            <select
              v-model="quickLandingUuid"
              :disabled="quickConfiguring"
              aria-label="快速生成落地机"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">
                仅入口到线路机
              </option>
              <option v-for="option in quickLandingOptions" :key="option.uuid" :value="option.uuid">
                {{ option.name }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="manager.quickNodes.length" class="text-[11px] text-muted-foreground">
          第 2 段任务会按所选线路机和落地机 IP 自动复用；不存在时在保存时创建。
        </p>
        <p v-if="quickTaskError" role="alert" class="text-xs text-destructive">
          {{ quickTaskError }}
        </p>
      </div>
      <span class="sr-only" aria-live="polite">{{ quickConfiguring ? '正在快速生成拓扑草稿' : '' }}</span>

      <div v-if="validationErrors.length" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <div v-for="error in validationErrors" :key="error">
          {{ error }}
        </div>
      </div>

      <article
        v-for="(route, routeIndex) in manager.routes"
        :key="route.id"
        :data-topology-route-id="route.id"
        class="rounded-xl border border-border/65 bg-background/40 p-3 sm:p-4"
      >
        <header class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold">线路 {{ routeIndex + 1 }}</span>
          </div>
          <div class="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === 0" aria-label="上移线路" @click="manager.moveRoute(routeIndex, -1)">
              <Icon icon="tabler:arrow-up" />
            </Button>
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === manager.routes.length - 1" aria-label="下移线路" @click="manager.moveRoute(routeIndex, 1)">
              <Icon icon="tabler:arrow-down" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="删除线路" @click="removeRoute(routeIndex)">
              <Icon icon="tabler:trash" />
            </Button>
          </div>
        </header>

        <div class="grid gap-3 lg:grid-cols-[1fr_1.1fr_1fr_1.1fr_1fr]">
          <div
            v-for="(node, nodeIndex) in route.nodes"
            :key="`${route.id}-node-${nodeIndex}`"
            class="space-y-2 lg:row-start-1"
            :class="nodeIndex === 0 ? 'lg:col-start-1' : nodeIndex === 1 ? 'lg:col-start-3' : 'lg:col-start-5'"
          >
            <label class="block text-[11px] text-muted-foreground">{{ nodeIndex === 0 ? '入口' : nodeIndex === 1 ? '线路机' : '落地机' }}</label>
            <Input
              v-if="nodeIndex === 0"
              v-model="node.name"
              :maxlength="TOPOLOGY_LIMITS.nodeNameLength"
              :aria-label="`第 ${routeIndex + 1} 条线路入口名称`"
              placeholder="北京电信"
            />
            <select
              v-else
              :value="node.name"
              :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 1 ? '线路机' : '落地机'}节点`"
              class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
              @change="selectRouteNode(route, nodeIndex, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option v-for="option in props.nodes" :key="option.uuid" :value="option.name" :disabled="manager.isAmbiguousNodeName(option.name)">
                {{ option.name }}{{ manager.isAmbiguousNodeName(option.name) ? `（重名，${option.region || option.uuid.slice(-8)}，不可用）` : '' }}
              </option>
            </select>
            <Input
              v-if="nodeIndex === 0"
              v-model="node.region"
              :maxlength="TOPOLOGY_LIMITS.regionLength"
              :aria-label="`第 ${routeIndex + 1} 条线路入口地区`"
              placeholder="地区代码（可选）"
              class="h-8 text-xs"
            />
            <Input v-model="node.role" :maxlength="TOPOLOGY_LIMITS.roleLength" :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 0 ? '入口' : nodeIndex === 1 ? '线路机' : '落地机'}角色`" placeholder="角色" class="h-8 text-xs" />
          </div>

          <div
            v-for="(metric, metricIndex) in route.metrics.slice(0, 2)"
            :key="`${route.id}-metric-${metricIndex}`"
            class="space-y-2 rounded-lg border border-border/50 bg-card/35 p-2"
            :class="metricIndex === 0 ? 'lg:col-start-2 lg:row-start-1' : 'lg:col-start-4 lg:row-start-1'"
          >
            <div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>第 {{ metricIndex + 1 }} 段指标</span>
              <select
                :value="metric.live ? 'live' : 'baseline'"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段指标模式`"
                class="min-h-8 rounded border border-input bg-background px-1.5 py-1 text-[11px] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                @change="setMetricMode(route, metric, ($event.target as HTMLSelectElement).value === 'live')"
              >
                <option value="live">
                  实时任务
                </option>
                <option value="baseline">
                  静态基线
                </option>
              </select>
            </div>
            <template v-if="metric.live">
              <select
                :value="metric.nodeName"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段探测来源`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                @change="selectMetricSource(route, metric, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">
                  探测来源节点
                </option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name" :disabled="manager.isAmbiguousNodeName(option.name)">
                  {{ option.name }}{{ manager.isAmbiguousNodeName(option.name) ? `（重名，${option.region || option.uuid.slice(-8)}，不可用）` : '' }}
                </option>
              </select>
              <select
                v-if="nodeTasks(metric.nodeName).length"
                :value="metric.taskFilter"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段 Ping 任务`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                @change="selectMetricTask(route, metric, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">
                  选择 Ping 任务
                </option>
                <option v-if="metric.taskFilter && !nodeTasks(metric.nodeName).includes(metric.taskFilter)" :value="metric.taskFilter">
                  {{ metric.taskFilter }}（已配置）
                </option>
                <option v-for="task in nodeTasks(metric.nodeName)" :key="task" :value="task">
                  {{ task }}
                </option>
              </select>
              <input
                v-else
                v-model="metric.taskFilter"
                :maxlength="TOPOLOGY_LIMITS.taskNameLength"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段 Ping 任务`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                placeholder="Ping 任务名称"
                @focus="loadTasks(metric.nodeName)"
              >
              <p class="text-[10px] text-muted-foreground" aria-live="polite">
                <template v-if="metricIndex === 1 && routeTaskPlanning[route.id]">
                  正在按落地机 IP 自动匹配任务…
                </template>
                <template v-else-if="metricIndex === 1 && routeTaskErrors[route.id]">
                  {{ routeTaskErrors[route.id] }}
                </template>
                <template v-else-if="nodeTaskState(metric.nodeName).loading">
                  正在读取任务…
                </template>
                <template v-else-if="nodeTaskState(metric.nodeName).error">
                  {{ nodeTaskState(metric.nodeName).error }}
                </template>
                <template v-else-if="nodeTasks(metric.nodeName).length">
                  已列出该来源节点可用的 Ping 任务
                </template>
                <template v-else>
                  未找到可用任务，可手动输入精确名称
                </template>
              </p>
            </template>
            <div class="grid grid-cols-2 gap-2">
              <label class="text-[10px] text-muted-foreground">备用延迟
                <input
                  type="number"
                  min="0"
                  step="1"
                  :value="metric.fallbackLatency ?? ''"
                  placeholder="ms"
                  class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                  @input="updateFallback(metric, 'fallbackLatency', $event)"
                >
              </label>
              <label class="text-[10px] text-muted-foreground">备用丢包
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  :value="metric.fallbackLoss ?? ''"
                  placeholder="%"
                  class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                  @input="updateFallback(metric, 'fallbackLoss', $event)"
                >
              </label>
            </div>
          </div>
        </div>
      </article>

      <div v-if="!manager.routes.length" class="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        还没有线路。选择线路机和落地机后点击“快速生成”，或手动添加线路。
      </div>

      <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl" :aria-busy="manager.saving">
        <Button variant="outline" :disabled="manager.saving" @click="reset">
          恢复已保存配置
        </Button>
        <Button :disabled="manager.saving || quickConfiguring || taskValidationPending || !manager.dirty || validationErrors.length > 0" @click="save">
          <Icon :icon="manager.saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="manager.saving && 'animate-spin'" />
          {{ manager.saving ? '保存中' : '保存并应用' }}
        </Button>
      </footer>
    </fieldset>
  </AppDialog>
</template>
