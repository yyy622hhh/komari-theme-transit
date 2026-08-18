import type { MaybeRefOrGetter } from 'vue'
import type { TopologyTaskLoadResult } from '@/composables/useTopologyTaskCatalog'
import type { TopologyHopProbe } from '@/services/ping-task.service'
import type { HopTaskVerdict } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { ref, toValue } from 'vue'
import { OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { describeTopologyHopProbe, normalizeTopologyHopProbe } from '@/services/ping-task.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { applyTopologyProbeToRoute, findTopologyProbeKey, findUniqueTopologyNode, getTopologyProbe, getTopologyRouteProbeKey, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'

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

export interface TopologyRetiredTaskCandidate {
  id: number
  name: string
}

/** 规划只需要读 `routes`，不依赖 `useTopologyManager()` 的其它状态。 */
export interface TopologyRoutePlannerManager {
  routes: TopologyRouteConfig[]
}

export interface TopologyRoutePlannerCatalog {
  loadTasks: (nodeName: string) => Promise<TopologyTaskLoadResult>
  rememberTask: (sourceUuid: string, taskName: string) => void
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
}

/**
 * 第 1 段（入口）的提示。
 *
 * 第 2 段一直有详细提示，第 1 段却什么都不说：线路机上没有同名 Ping 任务时，
 * `buildQuickTopologyRoute` 会把 `metrics[0].live` 置为 false，线路照样创建并保存，
 * 图上只剩「静态基线」和两个短横。操作者既不知道发生了什么，也不知道该去建任务。
 */
export function formatTopologyEntryHint(input: TopologyEntryHintInput): string {
  if (!input.sourceName.trim())
    return ''
  if (input.live)
    return `入口探测：${input.probeLabel || input.entryLabel} · 实时`
  if (input.probeLabel) {
    return `入口探测：线路机“${input.sourceName}”上没有名为“${input.expectedTaskName}”的 Ping 任务，`
      + '该段暂显示静态基线。在 Komari 中为这台节点创建同名任务后会自动转为实时。'
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
  const pendingRouteTasks = ref<Record<number, TopologyPendingRouteTask>>({})
  /** 新任务绑定并保存成功后可以清理掉的旧任务候选，按线路记录。 */
  const routeRetiredTasks = ref<Record<number, TopologyRetiredTaskCandidate[]>>({})
  const routeTaskPlanning = ref<Record<number, boolean>>({})
  const routeTaskErrors = ref<Record<number, string>>({})
  const routeTaskRuns = new Map<number, number>()

  function reset(): void {
    pendingRouteTasks.value = {}
    routeProbeStates.value = {}
    routeRetiredTasks.value = {}
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

  function rememberRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>): void {
    const retirable = tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
    const next = { ...routeRetiredTasks.value }
    if (retirable.length)
      next[routeId] = retirable
    else
      delete next[routeId]
    routeRetiredTasks.value = next
  }

  function reservedEntryNames(route?: TopologyRouteConfig): string[] {
    return toValue(nodes)
      .map(node => node.name)
      .filter(name => name.trim().toLowerCase() !== route?.nodes[0]?.name.trim().toLowerCase())
  }

  async function planRouteTasks(route: TopologyRouteConfig): Promise<void> {
    const runId = (routeTaskRuns.get(route.id) ?? 0) + 1
    routeTaskRuns.set(route.id, runId)
    clearPendingRouteTask(route.id)
    routeTaskErrors.value = { ...routeTaskErrors.value, [route.id]: '' }
    const source = findUniqueTopologyNode(toValue(nodes), route.nodes[1]?.name ?? '')
    const landing = findUniqueTopologyNode(toValue(nodes), route.nodes[2]?.name ?? '')
    const firstMetric = route.metrics[0]
    const secondMetric = route.metrics[1]
    if (!source) {
      clearRouteTaskPlanning(route.id)
      return
    }

    routeTaskPlanning.value = { ...routeTaskPlanning.value, [route.id]: true }
    try {
      const loaded = await catalog.loadTasks(source.name)
      if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
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
      expectedTaskName: probe?.taskFilter ?? '',
      entryLabel: route.nodes[0]?.name.trim() ?? '',
      sourceName: route.nodes[1]?.name.trim() ?? '',
      live: Boolean(route.metrics[0]?.live && route.metrics[0].taskFilter.trim()),
    })
  }

  function routeEntryHintTone(route: TopologyRouteConfig): boolean {
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
    pendingRouteTasks,
    routeRetiredTasks,
    routeTaskPlanning,
    routeTaskErrors,
    reset,
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
  }
}
