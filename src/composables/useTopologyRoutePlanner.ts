import type { MaybeRefOrGetter } from 'vue'
import type { TopologyTaskLoadResult } from '@/composables/useTopologyTaskCatalog'
import type { TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskVerdict } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyProbeOption, TopologyRouteConfig } from '@/utils/topologyHelper'
import { ref, toValue } from 'vue'
import { OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { describeTopologyHopProbe, normalizeTopologyHopProbe } from '@/services/ping-task.service'
import { planEntryProbeTask, planWorkingHopTask } from '@/services/topology-probe.service'
import { applyTopologyProbeToRoute, findTopologyProbeKey, getTopologyProbe, getTopologyProbeTarget, getTopologyRouteProbeKey, resolveTopologyNode, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'

export interface TopologyRouteProbeState {
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  exhausted: boolean
  switchedFrom: TopologyHopProbe | null
  targetAddress: string
}

export interface TopologyPendingRouteTask {
  sourceUuid: string
  targetUuid: string
  taskName: string
  probe: TopologyHopProbe
}

/** 入口待创建/换挡任务。`taskName` 必须是规划选中的真实任务名，`forceCreate` 表示换挡不能按同名复用。 */
export interface TopologyPendingEntryTask {
  sourceUuid: string
  probeKey: string
  taskName: string
  probe: TopologyHopProbe
  forceCreate: boolean
}

export interface TopologyRetiredTaskCandidate {
  id: number
  name: string
}

/** 规划只需要读 `routes`，不依赖 `useTopologyManager()` 的其它状态。 */
export interface TopologyRoutePlannerManager {
  routes: TopologyRouteConfig[]
}

export interface TopologyRoutePlannerCatalog {
  loadTasks: (nodeName: string, nodeUuid?: string) => Promise<TopologyTaskLoadResult>
  rememberTask: (sourceUuid: string, taskName: string) => void
}

export function findUniquePresetEntryTask(taskNames: readonly string[], entryName: string): string {
  const entryProbeKey = findTopologyProbeKey(entryName)
  if (!entryProbeKey)
    return ''
  const matches = taskNames.filter(task => findTopologyProbeKey(task) === entryProbeKey)
  return matches.length === 1 ? matches[0]! : ''
}

const HOP_PROBE_LADDER_TEXT = OPS_TOPOLOGY_HOP_PROBE_LADDER
  .map(rung => describeTopologyHopProbe(normalizeTopologyHopProbe(rung)))
  .join('、')

export interface TopologyRouteHintInput {
  planning: boolean
  taskError: string
  hasSource: boolean
  hasLanding: boolean
  state: TopologyRouteProbeState | undefined
  pending: boolean
}

/** 把当前探测状态翻成操作者能看懂的一句话；纯函数，独立可测。 */
export function formatTopologyRouteHint(input: TopologyRouteHintInput): string {
  if (input.planning)
    return '正在自动挑选可用的探测方式…'
  if (input.taskError)
    return input.taskError
  if (!input.hasSource)
    return '请选择线路机。'
  if (!input.hasLanding)
    return '请选择落地机。'
  const state = input.state
  if (!state)
    return ''
  const probeText = describeTopologyHopProbe(state.probe)
  if (state.exhausted)
    return `${HOP_PROBE_LADDER_TEXT} 都探测不通；落地机上报地址 ${state.targetAddress} 可能不是真实入站地址。`
  if (state.switchedFrom)
    return `${describeTopologyHopProbe(state.switchedFrom)} 探测不通，已自动改用 ${probeText}。`
  if (input.pending)
    return `正在按 ${probeText} 自动创建探测任务。`
  if (state.verdict === 'healthy')
    return `探测方式：${probeText} · 正常`
  if (state.verdict === 'dead')
    return `探测方式：${probeText} · 没有成功响应，正在自动换用其它方式。`
  return `探测方式：${probeText} · 正在等待首批采样`
}

export interface TopologyEntryHintInput {
  /** 入口对应的预设探测名，例如「北京电信」；自定义入口为空。 */
  probeLabel: string
  /** 预设入口期望匹配的 Ping 任务名。 */
  expectedTaskName: string
  /** 入口在线路图上的显示名。 */
  entryLabel: string
  sourceName: string
  /** 第 1 段是否已绑定实时任务。 */
  live: boolean
  /** 已经乐观标记为实时，探测任务还在保存流程里排队创建/换挡，尚未确认落地。 */
  pending: boolean
  /** 阶梯自愈状态；只有命中预设时才有。 */
  state: TopologyRouteProbeState | undefined
}

/**
 * 第 1 段（入口）的提示。
 *
 * 线路机上没有同名 Ping 任务时，Transit 会自动建一个指向该运营商落地测速点
 * 的探测任务并绑定，探测方式的初选和阶梯回退复用第 2 段同一套健康判定；这类
 * 任务测的是「线路机主动探测落地点」，方向和「该运营商用户访问线路机」正好
 * 相反，必须在提示里说清楚，不能让人误以为是正向体验。自定义入口（不对应
 * 任何预设）不掺这句话——那是操作者自己建的任务，方向由操作者自己判断。
 */
export function formatTopologyEntryHint(input: TopologyEntryHintInput): string {
  if (!input.sourceName.trim())
    return ''
  if (input.pending) {
    const switchedFrom = input.state?.switchedFrom
    if (switchedFrom && input.state)
      return `“${input.expectedTaskName}”按 ${describeTopologyHopProbe(switchedFrom)} 探测不通，正在自动改用 ${describeTopologyHopProbe(input.state.probe)} 重新创建。`
    return `正在为入口自动创建探测任务“${input.expectedTaskName}”…`
  }
  if (input.state?.exhausted)
    return `“${input.expectedTaskName}”按 ${HOP_PROBE_LADDER_TEXT} 都探测不通，需要手动处理（检查线路机是否能连到 ${input.state.targetAddress}，或换一个入口）。`
  if (input.live) {
    return input.probeLabel
      ? `入口探测：${input.probeLabel} · 实时（线路机主动探测运营商落地点，不代表该运营商用户访问这台线路机的真实体验）`
      : `入口探测：${input.entryLabel} · 实时`
  }
  if (input.probeLabel) {
    return `入口探测：线路机“${input.sourceName}”上没有名为“${input.expectedTaskName}”的 Ping 任务，正在自动创建。`
  }
  return `入口探测：自定义入口“${input.entryLabel}”未绑定实时任务，该段显示静态基线。`
}

/** 提示是否需要用醒目色：任务错误或阶梯穷尽都算需要操作者注意。 */
export function isTopologyRouteHintDestructive(input: { taskError: string, exhausted: boolean }): boolean {
  return Boolean(input.taskError || input.exhausted)
}

/**
 * 第 2 段（线路机 → 落地机）探测规划：调用 `planWorkingHopTask` 挑选/自愈探测
 * 方式，并维护每条线路的规划中/错误/待创建任务状态。第 1 段（入口）的静态
 * 预设匹配也在这里做，因为两段共用同一次 `catalog.loadTasks` 结果。
 */
export function useTopologyRoutePlanner(
  nodes: MaybeRefOrGetter<NodeData[]>,
  manager: TopologyRoutePlannerManager,
  catalog: TopologyRoutePlannerCatalog,
  isOpen: () => boolean,
) {
  const routeProbeStates = ref<Record<number, TopologyRouteProbeState>>({})
  const routeEntryProbeStates = ref<Record<number, TopologyRouteProbeState>>({})
  const pendingRouteTasks = ref<Record<number, TopologyPendingRouteTask>>({})
  const pendingEntryTasks = ref<Record<number, TopologyPendingEntryTask>>({})
  /** 新任务绑定并保存成功后可以清理掉的旧任务候选，按线路记录。 */
  const routeRetiredTasks = ref<Record<number, TopologyRetiredTaskCandidate[]>>({})
  /** 入口段的清理候选，独立于第 2 段的 `routeRetiredTasks`——两段各自记录，互不覆盖。 */
  const routeEntryRetiredTasks = ref<Record<number, TopologyRetiredTaskCandidate[]>>({})
  const routeTaskPlanning = ref<Record<number, boolean>>({})
  const routeTaskErrors = ref<Record<number, string>>({})
  const routeTaskRuns = new Map<number, number>()

  function reset(): void {
    pendingRouteTasks.value = {}
    pendingEntryTasks.value = {}
    routeProbeStates.value = {}
    routeEntryProbeStates.value = {}
    routeRetiredTasks.value = {}
    routeEntryRetiredTasks.value = {}
    routeTaskPlanning.value = {}
    routeTaskErrors.value = {}
    routeTaskRuns.clear()
  }

  /** 让该线路上一轮还没返回的 `planRouteTasks` 调用作废，不再写回状态。 */
  function bumpRouteRun(routeId: number): void {
    routeTaskRuns.set(routeId, (routeTaskRuns.get(routeId) ?? 0) + 1)
  }

  function cancelRouteTaskPlanning(): void {
    for (const [routeId, runId] of routeTaskRuns)
      routeTaskRuns.set(routeId, runId + 1)
    routeTaskPlanning.value = {}
  }

  function clearRouteTaskPlanning(routeId: number): void {
    if (!(routeId in routeTaskPlanning.value))
      return
    const next = { ...routeTaskPlanning.value }
    delete next[routeId]
    routeTaskPlanning.value = next
  }

  function clearPendingRouteTask(routeId: number): void {
    if (!pendingRouteTasks.value[routeId])
      return
    const nextPending = { ...pendingRouteTasks.value }
    delete nextPending[routeId]
    pendingRouteTasks.value = nextPending
  }

  function clearPendingEntryTask(routeId: number): void {
    if (!pendingEntryTasks.value[routeId])
      return
    const nextPending = { ...pendingEntryTasks.value }
    delete nextPending[routeId]
    pendingEntryTasks.value = nextPending
  }

  function clearRouteTaskError(routeId: number): void {
    if (!routeTaskErrors.value[routeId])
      return
    const nextErrors = { ...routeTaskErrors.value }
    delete nextErrors[routeId]
    routeTaskErrors.value = nextErrors
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

  function clearRouteEntryProbeState(routeId: number): void {
    if (routeEntryRetiredTasks.value[routeId]) {
      const nextRetired = { ...routeEntryRetiredTasks.value }
      delete nextRetired[routeId]
      routeEntryRetiredTasks.value = nextRetired
    }
    if (!routeEntryProbeStates.value[routeId])
      return
    const next = { ...routeEntryProbeStates.value }
    delete next[routeId]
    routeEntryProbeStates.value = next
  }

  function rememberRetiredTasksInto(
    target: typeof routeRetiredTasks,
    routeId: number,
    tasks: ReadonlyArray<{ id?: number, name: string }>,
  ): void {
    const retirable = tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
    const next = { ...target.value }
    if (retirable.length)
      next[routeId] = retirable
    else
      delete next[routeId]
    target.value = next
  }

  function rememberRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>): void {
    rememberRetiredTasksInto(routeRetiredTasks, routeId, tasks)
  }

  function rememberEntryRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>): void {
    rememberRetiredTasksInto(routeEntryRetiredTasks, routeId, tasks)
  }

  function reservedEntryNames(route?: TopologyRouteConfig): string[] {
    return toValue(nodes)
      .map(node => node.name)
      .filter(name => name.trim().toLowerCase() !== route?.nodes[0]?.name.trim().toLowerCase())
  }

  interface TopologyEntryTaskState {
    probeKey: string
    probe: TopologyProbeOption
    plan: Awaited<ReturnType<typeof planEntryProbeTask>>
  }

  /**
   * 入口段选中了预设时才规划（自定义入口或绑定了非预设自定义任务的入口都
   * 不碰）；只读，不写任何 route 状态，方便调用方先做完再统一检查过期。
   */
  async function planEntryTaskState(
    route: TopologyRouteConfig,
    sourceUuid: string,
    sourceName: string,
    options: { fresh?: boolean } = {},
  ): Promise<TopologyEntryTaskState | null> {
    const probeKey = getTopologyRouteProbeKey(route)
    if (!probeKey || !shouldAutoApplyTopologyProbe(route))
      return null
    const probe = getTopologyProbe(probeKey)
    const endpoint: TopologyPingEndpoint = { uuid: sourceUuid, name: sourceName }
    const plan = await planEntryProbeTask(endpoint, probe, options)
    return { probeKey, probe, plan }
  }

  function applyEntryTaskState(
    route: TopologyRouteConfig,
    sourceUuid: string,
    sourceName: string,
    state: TopologyEntryTaskState | null,
  ): void {
    if (!state) {
      clearPendingEntryTask(route.id)
      clearRouteEntryProbeState(route.id)
      return
    }
    const { probeKey, probe, plan } = state
    routeEntryProbeStates.value = {
      ...routeEntryProbeStates.value,
      [route.id]: {
        probe: plan.probe,
        verdict: plan.verdict,
        exhausted: plan.exhausted,
        switchedFrom: plan.switchedFrom,
        targetAddress: getTopologyProbeTarget(probe, plan.probe) || probe.landmarkAddress,
      },
    }
    rememberEntryRetiredTasks(route.id, plan.retiredTasks)
    const metric = route.metrics[0]
    if (!metric)
      return
    const taskName = plan.task.name.trim() || probe.taskFilter
    metric.live = true
    metric.nodeName = sourceName
    metric.taskFilter = taskName
    if (plan.needsCreation) {
      pendingEntryTasks.value = {
        ...pendingEntryTasks.value,
        [route.id]: { sourceUuid, probeKey, taskName, probe: plan.probe, forceCreate: plan.switchedFrom !== null },
      }
    }
    else {
      clearPendingEntryTask(route.id)
    }
  }

  async function planRouteTasks(route: TopologyRouteConfig): Promise<void> {
    const runId = (routeTaskRuns.get(route.id) ?? 0) + 1
    routeTaskRuns.set(route.id, runId)
    clearPendingRouteTask(route.id)
    clearPendingEntryTask(route.id)
    clearRouteEntryProbeState(route.id)
    routeTaskErrors.value = { ...routeTaskErrors.value, [route.id]: '' }
    const source = resolveTopologyNode(toValue(nodes), route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
    const landing = resolveTopologyNode(toValue(nodes), route.nodes[2]?.name ?? '', route.nodes[2]?.uuid ?? '')
    if (!source) {
      clearRouteTaskPlanning(route.id)
      return
    }
    if (route.nodes[1] && route.nodes[1].name.trim() !== source.name.trim())
      route.nodes[1].name = source.name
    if (landing && route.nodes[2] && route.nodes[2].name.trim() !== landing.name.trim())
      route.nodes[2].name = landing.name

    routeTaskPlanning.value = { ...routeTaskPlanning.value, [route.id]: true }
    try {
      const loaded = await catalog.loadTasks(source.name, source.uuid)
      if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
        return
      if (loaded.error)
        throw new Error(loaded.error)

      const probeKey = getTopologyRouteProbeKey(route)
      const firstMetric = route.metrics[0]
      if (probeKey && shouldAutoApplyTopologyProbe(route)) {
        applyTopologyProbeToRoute(route, probeKey, source.name, loaded.tasks, reservedEntryNames(route))
        // 离线线路机发不出样本，判死会走空整条阶梯，不给它规划入口任务。
        if (source.online !== false) {
          const entryState = await planEntryTaskState(route, source.uuid, source.name)
          if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
            return
          applyEntryTaskState(route, source.uuid, source.name, entryState)
        }
      }
      else if (firstMetric?.live && !firstMetric.taskFilter.trim()) {
        const matchingEntryTask = findUniquePresetEntryTask(loaded.tasks, route.nodes[0]?.name ?? '')
        if (matchingEntryTask)
          firstMetric.taskFilter = matchingEntryTask
      }

      const secondMetric = route.metrics[1]
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
      // 离线节点给不出样本，走阶梯会把 ICMP/443/80/22 建一遍并自动写回。
      if (source.online === false || landing.online === false)
        return
      const planned = await planWorkingHopTask(source, landing, secondMetric.taskFilter)
      if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
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
        catalog.rememberTask(source.uuid, planned.task.name)
      }
    }
    catch (error) {
      if (routeTaskRuns.get(route.id) === runId && isOpen() && manager.routes.includes(route)) {
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

  function routeHopTask(route: TopologyRouteConfig): string {
    return pendingRouteTasks.value[route.id]?.taskName || route.metrics[1]?.taskFilter.trim() || ''
  }

  function routeHint(route: TopologyRouteConfig): string {
    return formatTopologyRouteHint({
      planning: Boolean(routeTaskPlanning.value[route.id]),
      taskError: routeTaskErrors.value[route.id] ?? '',
      hasSource: Boolean(route.nodes[1]?.name.trim()),
      hasLanding: Boolean(route.nodes[2]?.name.trim()),
      state: routeProbeStates.value[route.id],
      pending: Boolean(pendingRouteTasks.value[route.id]),
    })
  }

  function routeEntryHint(route: TopologyRouteConfig): string {
    const probeKey = getTopologyRouteProbeKey(route)
    const probe = probeKey ? getTopologyProbe(probeKey) : null
    return formatTopologyEntryHint({
      probeLabel: probe?.label ?? '',
      expectedTaskName: pendingEntryTasks.value[route.id]?.taskName || route.metrics[0]?.taskFilter.trim() || probe?.taskFilter || '',
      entryLabel: route.nodes[0]?.name.trim() ?? '',
      sourceName: route.nodes[1]?.name.trim() ?? '',
      live: Boolean(route.metrics[0]?.live && route.metrics[0].taskFilter.trim()),
      pending: Boolean(pendingEntryTasks.value[route.id]),
      state: routeEntryProbeStates.value[route.id],
    })
  }

  function routeEntryHintTone(route: TopologyRouteConfig): boolean {
    if (routeEntryProbeStates.value[route.id]?.exhausted)
      return true
    return !routeEntryHint(route).includes('· 实时')
  }

  function routeHintTone(route: TopologyRouteConfig): boolean {
    return isTopologyRouteHintDestructive({
      taskError: routeTaskErrors.value[route.id] ?? '',
      exhausted: Boolean(routeProbeStates.value[route.id]?.exhausted),
    })
  }

  return {
    routeProbeStates,
    routeEntryProbeStates,
    pendingRouteTasks,
    pendingEntryTasks,
    routeRetiredTasks,
    routeEntryRetiredTasks,
    routeTaskPlanning,
    routeTaskErrors,
    reset,
    bumpRouteRun,
    cancelRouteTaskPlanning,
    clearRouteTaskPlanning,
    clearPendingRouteTask,
    clearPendingEntryTask,
    clearRouteTaskError,
    clearRouteProbeState,
    clearRouteEntryProbeState,
    rememberRetiredTasks,
    rememberEntryRetiredTasks,
    reservedEntryNames,
    planEntryTaskState,
    applyEntryTaskState,
    planRouteTasks,
    routeHopTask,
    routeHint,
    routeHintTone,
    routeEntryHint,
    routeEntryHintTone,
  }
}
