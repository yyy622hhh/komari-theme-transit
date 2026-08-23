import type { AdminPingTask, TopologyHopProbe } from '@/services/ping-task.service'
import type { PingMetricTaskStats } from '@/utils/rpc'
import { OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_ENTRY_PROBE_LADDER, OPS_TOPOLOGY_HOP_PROBE, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, partitionMetricEntityIds } from '@/services/metrics.service'
import {
  DEFAULT_TOPOLOGY_HOP_PROBE,
  isPingTaskAssignedToSource,
  isSameTopologyHopProbe,
  loadAdminPingTasks,
  normalizeTopologyHopProbe,
  topologyHopProbeFromTask,
} from '@/services/ping-task.service'

/**
 * 拓扑降级共用的原语：读线路机的探测画像、判死一个任务、按阶梯挑下一档。
 * `topology-hop-probe.service.ts`（第 2 段）和 `topology-entry-probe.service.ts`
 * （入口段）各自的规划函数都建在这些原语之上。
 */

/** 一个任务在回看窗口内的采样情况。 */
export interface HopTaskSamples {
  total: number
  valid: number
}

export type HopTaskVerdict = 'missing' | 'pending' | 'healthy' | 'dead'

export interface SourceProbeProfile {
  sourceUuid: string
  tasks: AdminPingTask[]
  samplesByTaskId: Map<string, HopTaskSamples>
  samplesByTaskName: Map<string, HopTaskSamples>
  /** Aggregated evidence only for learning which landing probes work elsewhere. */
  observedSamplesByTaskId: Map<string, HopTaskSamples>
}

export const LADDER: TopologyHopProbe[] = OPS_TOPOLOGY_HOP_PROBE_LADDER.map(rung => normalizeTopologyHopProbe(rung))
export const ENTRY_LADDER: TopologyHopProbe[] = OPS_TOPOLOGY_ENTRY_PROBE_LADDER.map(rung => normalizeTopologyHopProbe(rung))
export const CUSTOM_ENTRY_LADDER: TopologyHopProbe[] = OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER.map(rung => normalizeTopologyHopProbe(rung))

function readSamples(stat: PingMetricTaskStats): HopTaskSamples {
  return {
    total: Number.isFinite(stat.total) ? stat.total : 0,
    valid: Number.isFinite(stat.valid) ? stat.valid : 0,
  }
}

function taskNamesById(tasks: readonly AdminPingTask[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const task of tasks) {
    const taskId = String(task.id ?? '').trim()
    const name = task.name.trim()
    if (taskId && name)
      names.set(taskId, name)
  }
  return names
}

/** 拉齐这台线路机上所有任务的类型、目标和最近采样情况。 */
export async function loadSourceProbeProfile(sourceUuid: string, options: { fresh?: boolean } = {}): Promise<SourceProbeProfile> {
  const tasks = await loadAdminPingTasks(options)
  const entityIds = [...new Set([
    sourceUuid,
    ...tasks.flatMap(task => task.clients ?? []),
  ].map(uuid => uuid.trim()).filter(Boolean))]
  const statsResponses = await Promise.all(partitionMetricEntityIds(entityIds).map(batch => loadPingMetricStats({
    entity_ids: batch,
    hours: OPS_TOPOLOGY_HOP_PROBE.lookbackHours,
  }).catch(() => null)))
  const legacyRecords = statsResponses.every(response => response === null)
    ? (await loadPingRecordsWithTasks(OPS_TOPOLOGY_HOP_PROBE.lookbackHours).catch(() => null))?.records ?? []
    : []

  const samplesByTaskId = new Map<string, HopTaskSamples>()
  const samplesByTaskName = new Map<string, HopTaskSamples>()
  const observedSamplesByTaskId = new Map<string, HopTaskSamples>()
  const mergeSamples = (target: Map<string, HopTaskSamples>, key: string, samples: HopTaskSamples): void => {
    const previous = target.get(key)
    target.set(key, previous
      ? { total: previous.total + samples.total, valid: previous.valid + samples.valid }
      : samples)
  }
  for (const stat of statsResponses.flatMap(response => response?.stats ?? [])) {
    const taskId = String(stat.task_id).trim()
    if (!taskId)
      continue
    const samples = readSamples(stat)
    mergeSamples(observedSamplesByTaskId, taskId, samples)
    if (stat.entity_id !== sourceUuid)
      continue
    mergeSamples(samplesByTaskId, taskId, samples)
    const name = stat.name?.trim()
    if (name)
      mergeSamples(samplesByTaskName, name, samples)
  }

  if (legacyRecords.length) {
    const knownEntityIds = new Set(entityIds)
    const taskNames = taskNamesById(tasks)
    for (const record of legacyRecords) {
      const entityId = record.client?.trim() ?? ''
      const taskId = String(record.task_id ?? '').trim()
      if (!knownEntityIds.has(entityId) || !taskId)
        continue
      const samples = {
        total: 1,
        valid: Number.isFinite(record.value) && record.value >= 0 ? 1 : 0,
      }
      mergeSamples(observedSamplesByTaskId, taskId, samples)
      if (entityId !== sourceUuid)
        continue
      mergeSamples(samplesByTaskId, taskId, samples)
      const name = taskNames.get(taskId)
      if (name)
        mergeSamples(samplesByTaskName, name, samples)
    }
  }

  return { sourceUuid, tasks, samplesByTaskId, samplesByTaskName, observedSamplesByTaskId }
}

export function getHopTaskSamples(profile: SourceProbeProfile, task: Pick<AdminPingTask, 'id' | 'name'>): HopTaskSamples | null {
  return profile.samplesByTaskId.get(String(task.id ?? '').trim())
    ?? profile.samplesByTaskName.get(task.name.trim())
    ?? null
}

/**
 * 判断一个任务通不通。
 *
 * 还没出样本、或样本太少不足以下结论时都算 pending——不能因为任务刚建好就
 * 立刻判死然后换方式。
 */
export function assessHopTask(profile: SourceProbeProfile, task: Pick<AdminPingTask, 'id' | 'name'>): HopTaskVerdict {
  const samples = getHopTaskSamples(profile, task)
  if (!samples || samples.total <= 0)
    return 'pending'
  if (samples.valid > 0)
    return 'healthy'
  return samples.total >= OPS_TOPOLOGY_HOP_PROBE.deadSamples ? 'dead' : 'pending'
}

export function ladderIndex(probe: TopologyHopProbe, ladder: readonly TopologyHopProbe[] = LADDER): number {
  return ladder.findIndex(rung => isSameTopologyHopProbe(rung, probe))
}

/**
 * 首次建任务时先挑对探测方式。
 *
 * 依据是这台线路机上**已经在正常出数**的任务，但只借用「这台机器能不能发
 * ICMP / TCP」这一个结论，不借用具体用了哪个端口：来源节点其他任务用 80 出
 * 数，只能证明这台线路机的出站 TCP 没被墙，不能证明**新落地机**上开着 80——
 * 运营商入口任务和这台落地机是完全不同的目的地。ICMP 有出数就用 ICMP；确定
 * 发不了 ICMP 但有 TCP 在出数时，一律从阶梯里第一个 TCP 档（443）开始，交给
 * 逐档判死的阶梯自己走到真正开放的端口，不在这里猜。
 */
export function chooseInitialHopProbe(profile: SourceProbeProfile): TopologyHopProbe {
  const healthyTasks = profile.tasks.filter((task) => {
    if (!isPingTaskAssignedToSource(task, profile.sourceUuid))
      return false
    return (getHopTaskSamples(profile, task)?.valid ?? 0) > 0
  })

  if (healthyTasks.some(task => task.type.trim().toLowerCase() === 'icmp'))
    return DEFAULT_TOPOLOGY_HOP_PROBE

  const hasHealthyTcp = healthyTasks.some(task => topologyHopProbeFromTask(task)?.type === 'tcp')
  if (!hasHealthyTcp)
    return DEFAULT_TOPOLOGY_HOP_PROBE

  return LADDER.find(rung => rung.type === 'tcp') ?? DEFAULT_TOPOLOGY_HOP_PROBE
}

/** 从当前探测方式往后找下一个还没被判死的阶梯档位。 */
export function nextLadderProbe(
  profile: SourceProbeProfile,
  current: TopologyHopProbe,
  existingTasks: readonly AdminPingTask[],
  ladder: readonly TopologyHopProbe[] = LADDER,
): TopologyHopProbe | null {
  const startIndex = ladderIndex(current, ladder)
  for (let index = startIndex + 1; index < ladder.length; index++) {
    const rung = ladder[index]!
    const existing = existingTasks.find((task) => {
      const probe = topologyHopProbeFromTask(task)
      return probe !== null && isSameTopologyHopProbe(probe, rung)
    })
    if (!existing || assessHopTask(profile, existing) !== 'dead')
      return rung
  }
  return null
}
