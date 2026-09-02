import type { MaybeRefOrGetter } from 'vue'
import type { TopologyTaskLoadResult } from '@/composables/useTopologyTaskCatalog'
import type { TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskVerdict } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { ref, toValue } from 'vue'
import { OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { describeTopologyHopProbe, normalizeTopologyHopProbe } from '@/services/ping-task.service'
import { planEntryProbeTask, planWorkingHopTask } from '@/services/topology-probe.service'
import { applyTopologyProbeToRoute, getTopologyRouteEntryProbe, getTopologyRouteProbeKey, resolveTopologyNode, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'
import { getTopologyMetricProbeMode } from '@/utils/topologyModel'
import { findTopologyProbeKey, getTopologyProbeTarget } from '@/utils/topologyPresets'

export interface TopologyRouteProbeState {
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  exhausted: boolean
  switchedFrom: TopologyHopProbe | null
  targetAddress: string
}

export interface TopologyPendingRouteTask {
  segmentIndex: number
  sourceUuid: string
  targetUuid: string
  taskName: string
  probe: TopologyHopProbe
  targetHost?: string
}

export function topologySegmentKey(routeId: number, segmentIndex: number): string {
  return `${routeId}:${segmentIndex}`
}

export function isTopologySegmentKeyForRoute(key: string, routeId: number): boolean {
  return Number(key.split(':')[0]) === routeId
}

export function readTopologySegmentRecord<T>(
  record: Readonly<Record<string, T>>,
  routeId: number,
  segmentIndex: number,
): T | undefined {
  return record[topologySegmentKey(routeId, segmentIndex)]
    ?? (segmentIndex === 1 ? record[String(routeId)] : undefined)
}

/** 入口待创建/换挡任务。`taskName` 必须是规划选中的真实任务名，`forceCreate` 表示换挡不能按同名复用。 */
export interface TopologyPendingEntryTask {
  sourceUuid: string
  probeKey: string
  entryProbe?: TopologyProbeOption
  taskName: string
  probe: TopologyHopProbe
  forceCreate: boolean
}

export interface TopologyRetiredTaskCandidate {
  id: number
  name: string
}
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

function ladderText(ladder: readonly TopologyHopProbe[]): string {
  return ladder.map(rung => describeTopologyHopProbe(normalizeTopologyHopProbe(rung))).join('、')
}

const HOP_PROBE_LADDER_TEXT = ladderText(OPS_TOPOLOGY_HOP_PROBE_LADDER)
const ENTRY_PROBE_LADDER_TEXT = ladderText(OPS_TOPOLOGY_ENTRY_PROBE_LADDER)
const CUSTOM_ENTRY_PROBE_LADDER_TEXT = ladderText(OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER)
export interface TopologyRouteHintInput {
  planning: boolean
  taskError: string
  hasSource: boolean
  hasLanding: boolean
  state: TopologyRouteProbeState | undefined
  pending: boolean
}

export function formatTopologyRouteHint(input: TopologyRouteHintInput): string {
  if (input.planning)
    return '正在自动挑选可用的探测方式…'
  if (input.taskError)
    return input.taskError
  if (!input.hasSource)
    return '请选择线路机。'
  if (!input.hasLanding)
    return ''
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
    return `探测方式：${probeText} · 可用`
  if (state.verdict === 'dead')
    return `探测方式：${probeText} · 没有成功响应，正在自动换用其它方式。`
  return `探测方式：${probeText} · 正在等待首批采样`
}

export interface TopologyEntryHintInput {
  probeLabel: string
  expectedTaskName: string
  entryLabel: string
  sourceName: string
  live: boolean
  pending: boolean
  state: TopologyRouteProbeState | undefined
}

/** 第 1 段入口提示。预设入口会写明探测方向与用户访问相反；自定义入口不掺这句话。 */
export function formatTopologyEntryHint(input: TopologyEntryHintInput): string {
  if (!input.sourceName.trim())
    return ''
  if (input.pending) {
    const switchedFrom = input.state?.switchedFrom
    if (switchedFrom && input.state)
      return `“${input.expectedTaskName}”按 ${describeTopologyHopProbe(switchedFrom)} 探测不通，正在自动改用 ${describeTopologyHopProbe(input.state.probe)} 重新创建。`
    return `正在为入口自动创建探测任务“${input.expectedTaskName}”…`
  }
  if (input.state?.exhausted) {
    const ladder = input.probeLabel ? ENTRY_PROBE_LADDER_TEXT : CUSTOM_ENTRY_PROBE_LADDER_TEXT
    return `“${input.expectedTaskName}”按 ${ladder} 都探测不通，需要手动处理（检查线路机是否能连到 ${input.state.targetAddress}，或换一个入口）。`
  }
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

export function isTopologyRouteHintDestructive(input: { taskError: string, exhausted: boolean }): boolean {
  return Boolean(input.taskError || input.exhausted)
}

export function useTopologyRoutePlanner(
  nodes: MaybeRefOrGetter<NodeData[]>,
  manager: TopologyRoutePlannerManager,
  catalog: TopologyRoutePlannerCatalog,
  isOpen: () => boolean,
) {
  const routeProbeStates = ref<Record<string, TopologyRouteProbeState>>({})
  const routeEntryProbeStates = ref<Record<number, TopologyRouteProbeState>>({})
  const pendingRouteTasks = ref<Record<string, TopologyPendingRouteTask>>({})
  const pendingEntryTasks = ref<Record<number, TopologyPendingEntryTask>>({})
  const routeRetiredTasks = ref<Record<string, TopologyRetiredTaskCandidate[]>>({})
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

  function clearPendingRouteTask(routeId: number, segmentIndex?: number): void {
    const nextPending = { ...pendingRouteTasks.value }
    if (segmentIndex === undefined) {
      delete nextPending[String(routeId)]
      for (const key of Object.keys(nextPending)) {
        if (isTopologySegmentKeyForRoute(key, routeId))
          delete nextPending[key]
      }
    }
    else {
      delete nextPending[topologySegmentKey(routeId, segmentIndex)]
      if (segmentIndex === 1)
        delete nextPending[String(routeId)]
    }
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

  function clearRouteProbeState(routeId: number, segmentIndex?: number): void {
    const clearKeys = (record: Record<string, unknown>): void => {
      if (segmentIndex === undefined) {
        delete record[String(routeId)]
        for (const key of Object.keys(record)) {
          if (isTopologySegmentKeyForRoute(key, routeId))
            delete record[key]
        }
      }
      else {
        delete record[topologySegmentKey(routeId, segmentIndex)]
        if (segmentIndex === 1)
          delete record[String(routeId)]
      }
    }
    const nextRetired = { ...routeRetiredTasks.value }
    clearKeys(nextRetired)
    routeRetiredTasks.value = nextRetired
    const next = { ...routeProbeStates.value }
    clearKeys(next)
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
    target: { value: Record<string, TopologyRetiredTaskCandidate[]> },
    key: string,
    tasks: ReadonlyArray<{ id?: number, name: string }>,
  ): void {
    const retirable = tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
    const next = { ...target.value }
    if (retirable.length)
      next[key] = retirable
    else
      delete next[key]
    target.value = next
  }

  function rememberRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>, segmentIndex = 1): void {
    rememberRetiredTasksInto(routeRetiredTasks, topologySegmentKey(routeId, segmentIndex), tasks)
  }

  function rememberEntryRetiredTasks(routeId: number, tasks: ReadonlyArray<{ id?: number, name: string }>): void {
    rememberRetiredTasksInto(routeEntryRetiredTasks, String(routeId), tasks)
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

  /** 内置预设或携带有效目标的自定义入口才规划；这里只读，方便统一检查过期。 */
  async function planEntryTaskState(
    route: TopologyRouteConfig,
    sourceUuid: string,
    sourceName: string,
    options: { fresh?: boolean } = {},
  ): Promise<TopologyEntryTaskState | null> {
    const probe = getTopologyRouteEntryProbe(route)
    const isCustom = Boolean(route.nodes[0]?.probeTarget?.trim())
    if (!probe || (!isCustom && !shouldAutoApplyTopologyProbe(route)))
      return null
    const endpoint: TopologyPingEndpoint = { uuid: sourceUuid, name: sourceName }
    const plan = await planEntryProbeTask(endpoint, probe, { ...options, currentTaskName: route.metrics[0]?.taskFilter })
    return { probeKey: probe.key, probe, plan }
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
    metric.probeMode = 'live'
    metric.nodeName = sourceName
    metric.taskFilter = taskName
    catalog.rememberTask(sourceUuid, taskName)
    if (plan.needsCreation) {
      pendingEntryTasks.value = {
        ...pendingEntryTasks.value,
        [route.id]: { sourceUuid, probeKey, entryProbe: probe, taskName, probe: plan.probe, forceCreate: plan.switchedFrom !== null || Boolean(route.nodes[0]?.probeTarget?.trim()) },
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
    if (!source) {
      clearRouteTaskPlanning(route.id)
      return
    }
    if (route.nodes[1] && route.nodes[1].name.trim() !== source.name.trim())
      route.nodes[1].name = source.name
    for (let index = 2; index < route.nodes.length; index++) {
      const configured = route.nodes[index]
      const resolved = resolveTopologyNode(toValue(nodes), configured?.name ?? '', configured?.uuid ?? '')
      if (configured && resolved && configured.name.trim() !== resolved.name.trim())
        configured.name = resolved.name
    }

    const segmentCount = Math.max(1, route.nodes.filter(node => node.name.trim()).length - 1)
    if (route.metrics.slice(0, segmentCount).every(metric => getTopologyMetricProbeMode(metric) === 'static')) {
      clearRouteTaskPlanning(route.id)
      return
    }

    routeTaskPlanning.value = { ...routeTaskPlanning.value, [route.id]: true }
    try {
      const loaded = await catalog.loadTasks(source.name, source.uuid)
      if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
        return
      if (loaded.error)
        throw new Error(loaded.error)

      const probeKey = getTopologyRouteProbeKey(route)
      const entryProbe = getTopologyRouteEntryProbe(route)
      const customEntry = Boolean(route.nodes[0]?.probeTarget?.trim())
      const firstMetric = route.metrics[0]
      if (firstMetric && getTopologyMetricProbeMode(firstMetric) !== 'static' && entryProbe && (customEntry || shouldAutoApplyTopologyProbe(route))) {
        if (!customEntry && probeKey)
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

      for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex++) {
        const segmentSource = resolveTopologyNode(toValue(nodes), route.nodes[segmentIndex]?.name ?? '', route.nodes[segmentIndex]?.uuid ?? '')
        const segmentTarget = resolveTopologyNode(toValue(nodes), route.nodes[segmentIndex + 1]?.name ?? '', route.nodes[segmentIndex + 1]?.uuid ?? '')
        const metric = route.metrics[segmentIndex]
        if (metric && getTopologyMetricProbeMode(metric) === 'static') {
          clearRouteProbeState(route.id, segmentIndex)
          clearPendingRouteTask(route.id, segmentIndex)
          continue
        }
        if (!segmentSource || !segmentTarget || !metric) {
          clearRouteProbeState(route.id, segmentIndex)
          clearPendingRouteTask(route.id, segmentIndex)
          if (metric) {
            metric.probeMode = 'auto'
            metric.live = false
            metric.nodeName = ''
            metric.taskFilter = ''
          }
          continue
        }
        if (segmentSource.uuid !== source.uuid) {
          const hopLoaded = await catalog.loadTasks(segmentSource.name, segmentSource.uuid)
          if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
            return
          if (hopLoaded.error)
            throw new Error(hopLoaded.error)
        }
        // 离线节点不走阶梯；已有绑定仍记进目录，避免保存按钮一直转圈。
        if (segmentSource.online === false || segmentTarget.online === false) {
          if (metric.live && metric.taskFilter.trim())
            catalog.rememberTask(segmentSource.uuid, metric.taskFilter)
          continue
        }
        const planned = await planWorkingHopTask(segmentSource, segmentTarget, metric.taskFilter)
        if (routeTaskRuns.get(route.id) !== runId || !isOpen() || !manager.routes.includes(route))
          return
        metric.live = true
        metric.probeMode = 'live'
        metric.nodeName = segmentSource.name
        metric.taskFilter = planned.task.name
        const key = topologySegmentKey(route.id, segmentIndex)
        routeProbeStates.value = {
          ...routeProbeStates.value,
          [key]: {
            probe: planned.probe,
            verdict: planned.verdict,
            exhausted: planned.exhausted,
            switchedFrom: planned.switchedFrom,
            targetAddress: planned.targetAddress,
          },
        }
        rememberRetiredTasks(route.id, planned.retiredTasks, segmentIndex)
        if (planned.needsCreation) {
          pendingRouteTasks.value = {
            ...pendingRouteTasks.value,
            [key]: {
              segmentIndex,
              sourceUuid: segmentSource.uuid,
              targetUuid: segmentTarget.uuid,
              taskName: planned.task.name,
              probe: planned.probe,
              targetHost: planned.targetAddress,
            },
          }
        }
        catalog.rememberTask(segmentSource.uuid, planned.task.name)
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

  function routeHopTask(route: TopologyRouteConfig, segmentIndex = 1): string {
    return readTopologySegmentRecord(pendingRouteTasks.value, route.id, segmentIndex)?.taskName
      || route.metrics[segmentIndex]?.taskFilter.trim()
      || ''
  }

  function routeHint(route: TopologyRouteConfig): string {
    if (routeTaskPlanning.value[route.id] || routeTaskErrors.value[route.id]) {
      return formatTopologyRouteHint({
        planning: Boolean(routeTaskPlanning.value[route.id]),
        taskError: routeTaskErrors.value[route.id] ?? '',
        hasSource: Boolean(route.nodes[1]?.name.trim()),
        hasLanding: Boolean(route.nodes.at(-1)?.name.trim()),
        state: undefined,
        pending: false,
      })
    }
    const segmentCount = Math.max(1, route.nodes.filter(node => node.name.trim()).length - 1)
    return Array.from({ length: Math.max(0, segmentCount - 1) }, (_, offset) => offset + 1)
      .map((segmentIndex) => {
        const hint = formatTopologyRouteHint({
          planning: false,
          taskError: '',
          hasSource: Boolean(route.nodes[segmentIndex]?.name.trim()),
          hasLanding: Boolean(route.nodes[segmentIndex + 1]?.name.trim()),
          state: readTopologySegmentRecord(routeProbeStates.value, route.id, segmentIndex),
          pending: Boolean(readTopologySegmentRecord(pendingRouteTasks.value, route.id, segmentIndex)),
        })
        if (!hint || segmentCount <= 2)
          return hint
        return `${route.nodes[segmentIndex]?.name} → ${route.nodes[segmentIndex + 1]?.name}：${hint}`
      })
      .filter(Boolean)
      .join('；')
  }
  function routeEntryHint(route: TopologyRouteConfig): string {
    const metric = route.metrics[0]
    if (metric && getTopologyMetricProbeMode(metric) === 'static')
      return `入口探测：${route.nodes[0]?.name.trim() || '自定义入口'} · 静态基线（不会创建探测任务）`
    const probe = getTopologyRouteEntryProbe(route)
    const customEntry = Boolean(route.nodes[0]?.probeTarget?.trim())
    return formatTopologyEntryHint({
      probeLabel: customEntry ? '' : probe?.label ?? '',
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
      exhausted: Object.entries(routeProbeStates.value).some(([key, state]) => isTopologySegmentKeyForRoute(key, route.id) && state.exhausted),
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
