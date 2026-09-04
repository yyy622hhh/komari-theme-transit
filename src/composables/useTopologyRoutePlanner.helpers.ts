import type { TopologyHopProbe } from '@/services/ping-task.service'
import type { HopTaskVerdict } from '@/services/topology-probe.service'
import { OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_ENTRY_PROBE_LADDER } from '@/constants/ops'
import { describeTopologyHopProbe, normalizeTopologyHopProbe } from '@/services/ping-task.service'
import { findTopologyProbeKey } from '@/utils/topologyPresets'

export interface TopologyRouteProbeState {
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  exhausted: boolean
  switchedFrom: TopologyHopProbe | null
  targetAddress: string
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

const HOP_PROBE_LADDER_TEXT = describeTopologyHopProbe({ type: 'icmp' })
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
  if (input.probeLabel)
    return `入口探测：线路机“${input.sourceName}”上没有名为“${input.expectedTaskName}”的 Ping 任务，正在自动创建。`
  return `入口探测：自定义入口“${input.entryLabel}”未绑定实时任务，该段显示静态基线。`
}

export function isTopologyRouteHintDestructive(input: { taskError: string, exhausted: boolean }): boolean {
  return Boolean(input.taskError || input.exhausted)
}
