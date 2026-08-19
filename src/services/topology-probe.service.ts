import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { PingMetricTaskStats } from '@/utils/rpc'
import type { TopologyProbeOption } from '@/utils/topologyHelper'
import { OPS_TOPOLOGY_HOP_PROBE, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, partitionMetricEntityIds } from '@/services/metrics.service'
import {
  buildTopologyHopTarget,
  DEFAULT_TOPOLOGY_HOP_PROBE,
  draftTopologyPingTask,
  findTopologyPingTask,
  findTopologyPingTaskByName,
  isPingTaskAssignedToSource,
  isSameTopologyHopProbe,
  listTopologyPingTasks,
  loadAdminPingTasks,
  normalizeTopologyHopProbe,
  pingTaskTargetHost,
  topologyHopProbeFromTask,
  topologyHopTaskNameCandidates,
  topologyPingTargets,
} from '@/services/ping-task.service'
import { getTopologyProbeTarget, normalizePingTaskName, topologyEntryTaskName } from '@/utils/topologyHelper'

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

export interface HopTaskPlan {
  task: AdminPingTask
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  needsCreation: boolean
  /** 阶梯已经走完，所有探测方式都判死。 */
  exhausted: boolean
  /** 本次因为判死而从哪种探测方式切换过来；没切换则为 null。 */
  switchedFrom: TopologyHopProbe | null
  /** 落地机上报的地址，阶梯全死时用来提示地址本身可能不对。 */
  targetAddress: string
  /**
   * 名称符合主题规则、已判死且不是当前选择的清理候选。调用方还必须用本会话
   * 实际创建的任务 ID 证明所有权，不能仅凭名称执行删除。
   */
  retiredTasks: AdminPingTask[]
}

const LADDER: TopologyHopProbe[] = OPS_TOPOLOGY_HOP_PROBE_LADDER.map(rung => normalizeTopologyHopProbe(rung))

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

function ladderIndex(probe: TopologyHopProbe): number {
  return LADDER.findIndex(rung => isSameTopologyHopProbe(rung, probe))
}

/**
 * 首次建任务时先挑对探测方式。
 *
 * 依据是这台线路机上**已经在正常出数**的任务：ICMP 有出数就说明这台机器能发
 * ICMP；否则改用出数的 TCP 端口。这样在 ICMP 被禁的机器上第一次就建对，不用
 * 等阶梯回退。
 */
export function chooseInitialHopProbe(profile: SourceProbeProfile): TopologyHopProbe {
  const healthyTasks = profile.tasks.filter((task) => {
    if (!isPingTaskAssignedToSource(task, profile.sourceUuid))
      return false
    return (getHopTaskSamples(profile, task)?.valid ?? 0) > 0
  })

  if (healthyTasks.some(task => task.type.trim().toLowerCase() === 'icmp'))
    return DEFAULT_TOPOLOGY_HOP_PROBE

  const portCounts = new Map<number, number>()
  for (const task of healthyTasks) {
    const probe = topologyHopProbeFromTask(task)
    if (probe?.type === 'tcp' && probe.port)
      portCounts.set(probe.port, (portCounts.get(probe.port) ?? 0) + 1)
  }
  if (!portCounts.size)
    return DEFAULT_TOPOLOGY_HOP_PROBE

  // 用得最多的端口优先；打平时按阶梯顺序，保证结果稳定可预期。
  const [port] = [...portCounts.entries()].sort((left, right) => right[1] - left[1]
    || ladderIndex({ type: 'tcp', port: left[0] }) - ladderIndex({ type: 'tcp', port: right[0] })
    || left[0] - right[0])[0]!
  return { type: 'tcp', port }
}

/** 从当前探测方式往后找下一个还没被判死的阶梯档位。 */
function nextLadderProbe(
  profile: SourceProbeProfile,
  current: TopologyHopProbe,
  existingTasks: readonly AdminPingTask[],
): TopologyHopProbe | null {
  const startIndex = ladderIndex(current)
  for (let index = startIndex + 1; index < LADDER.length; index++) {
    const rung = LADDER[index]!
    const existing = existingTasks.find((task) => {
      const probe = topologyHopProbeFromTask(task)
      return probe !== null && isSameTopologyHopProbe(probe, rung)
    })
    if (!existing || assessHopTask(profile, existing) !== 'dead')
      return rung
  }
  return null
}

function getObservedTaskSamples(
  profile: SourceProbeProfile,
  task: Pick<AdminPingTask, 'id'>,
): HopTaskSamples | null {
  const taskId = String(task.id ?? '').trim()
  return taskId ? profile.observedSamplesByTaskId.get(taskId) ?? null : null
}

/**
 * 找出其他来源访问同一落地地址时已经实际成功过的探测方式。
 *
 * 这里只学习协议和端口，不能把跨来源样本用于当前来源的健康判定。
 */
function healthyLandingProbes(
  profile: SourceProbeProfile,
  landing: TopologyPingEndpoint,
): TopologyHopProbe[] {
  const targetHosts = new Set(topologyPingTargets(landing))
  const probes: TopologyHopProbe[] = []
  for (const task of profile.tasks) {
    if (!targetHosts.has(pingTaskTargetHost(task.target)))
      continue
    if ((getObservedTaskSamples(profile, task)?.valid ?? 0) <= 0)
      continue
    const probe = topologyHopProbeFromTask(task)
    if (!probe || probes.some(existing => isSameTopologyHopProbe(existing, probe)))
      continue
    probes.push(probe)
  }
  return probes
}

/**
 * 计划第 2 段该用哪个任务——只读，不发写请求。
 *
 * 解析顺序：先按已绑定的任务名认回来，认不到再按落地机地址找历史 ICMP 任务，
 * 都没有才计划新建。已绑定的任务被判死时自动推进到阶梯下一档。
 *
 * 挑出可以安全清理的旧 hop 任务。
 *
 * 这里只按名称、健康状态和当前选择收集候选；最终删除前还要核对本会话创建记录。
 */
function isThemeGeneratedHopTask(
  source: TopologyPingEndpoint,
  landing: TopologyPingEndpoint,
  taskName: string,
): boolean {
  const name = taskName.trim()
  return LADDER.some(rung => topologyHopTaskNameCandidates(source, landing, rung).includes(name))
}

function entryTaskNameCandidates(probe: TopologyProbeOption): Set<string> {
  return new Set([
    probe.taskFilter,
    probe.label,
    topologyEntryTaskName(probe, { type: 'icmp' }),
    ...LADDER.filter(rung => rung.type === 'tcp').map(rung => topologyEntryTaskName(probe, rung)),
  ].map(normalizePingTaskName))
}

function entryProbeTarget(probe: TopologyProbeOption, hopProbe: TopologyHopProbe): string {
  return getTopologyProbeTarget(probe, hopProbe)
}

function collectRetiredTasks(
  profile: SourceProbeProfile,
  source: TopologyPingEndpoint,
  landing: TopologyPingEndpoint,
  hopTasks: readonly AdminPingTask[],
  selectedTaskName: string,
): AdminPingTask[] {
  return hopTasks.filter((task) => {
    if (task.name.trim() === selectedTaskName.trim() || !Number.isInteger(task.id))
      return false
    if (!isThemeGeneratedHopTask(source, landing, task.name))
      return false
    return assessHopTask(profile, task) === 'dead'
  })
}

export async function planWorkingHopTask(
  source: TopologyPingEndpoint,
  landing: TopologyPingEndpoint,
  currentTaskName = '',
  options: { fresh?: boolean } = {},
): Promise<HopTaskPlan> {
  if (!source.uuid.trim() || !landing.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  const targetAddress = topologyPingTargets(landing)[0] ?? ''
  if (!targetAddress)
    throw new Error(`落地机“${landing.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)

  const profile = await loadSourceProbeProfile(source.uuid, options)
  const hopTasks = listTopologyPingTasks(profile.tasks, source.uuid, landing)
  // 只有当按名字认回来的任务确实指向当前落地机时才认它。绑错落地机或落地机被
  // 改过时，仍然按地址重新推导，让主题自己纠正。
  const named = findTopologyPingTaskByName(profile.tasks, source.uuid, currentTaskName)
  const bound = (named && hopTasks.some(task => task.name === named.name) ? named : undefined)
    ?? findTopologyPingTask(profile.tasks, source.uuid, landing)

  const retire = (selectedTaskName: string) => collectRetiredTasks(profile, source, landing, hopTasks, selectedTaskName)
  const planForTask = (
    task: AdminPingTask,
    probe: TopologyHopProbe,
    switchedFrom: TopologyHopProbe | null,
  ): HopTaskPlan => ({
    task,
    probe,
    verdict: assessHopTask(profile, task),
    needsCreation: false,
    exhausted: false,
    switchedFrom,
    targetAddress,
    retiredTasks: retire(task.name),
  })
  const planForProbe = (
    probe: TopologyHopProbe,
    switchedFrom: TopologyHopProbe | null,
  ): HopTaskPlan | null => {
    const reused = findTopologyPingTask(profile.tasks, source.uuid, landing, probe)
    if (reused && assessHopTask(profile, reused) === 'dead')
      return null
    if (reused)
      return planForTask(reused, probe, switchedFrom)
    const task = draftTopologyPingTask(source, landing, probe, profile.tasks)
    return {
      task,
      probe,
      verdict: 'pending',
      needsCreation: true,
      exhausted: false,
      switchedFrom,
      targetAddress,
      retiredTasks: retire(task.name),
    }
  }
  const existingHealthy = (excludedName = ''): AdminPingTask | undefined => hopTasks.find(task => (
    task.name.trim() !== excludedName.trim() && assessHopTask(profile, task) === 'healthy'
  ))

  if (bound) {
    const boundProbe = topologyHopProbeFromTask(bound) ?? DEFAULT_TOPOLOGY_HOP_PROBE
    const verdict = assessHopTask(profile, bound)
    if (verdict !== 'dead') {
      return {
        task: bound,
        probe: boundProbe,
        verdict,
        needsCreation: false,
        exhausted: false,
        switchedFrom: null,
        targetAddress,
        retiredTasks: retire(bound.name),
      }
    }

    const healthyTask = existingHealthy(bound.name)
    if (healthyTask) {
      const healthyProbe = topologyHopProbeFromTask(healthyTask) ?? DEFAULT_TOPOLOGY_HOP_PROBE
      return planForTask(healthyTask, healthyProbe, boundProbe)
    }

    for (const provenProbe of healthyLandingProbes(profile, landing)) {
      const provenPlan = planForProbe(provenProbe, boundProbe)
      if (provenPlan)
        return provenPlan
    }

    const nextProbe = nextLadderProbe(profile, boundProbe, hopTasks)
    if (!nextProbe) {
      return {
        task: bound,
        probe: boundProbe,
        verdict: 'dead',
        needsCreation: false,
        exhausted: true,
        switchedFrom: null,
        targetAddress,
        // 阶梯已经走完，留着这些任务当作「这一档试过了」的记录，删掉只会让下次
        // 复检重新把它们建回来。
        retiredTasks: [],
      }
    }
    return planForProbe(nextProbe, boundProbe)!
  }

  const healthyTask = existingHealthy()
  if (healthyTask) {
    const healthyProbe = topologyHopProbeFromTask(healthyTask) ?? DEFAULT_TOPOLOGY_HOP_PROBE
    return planForTask(healthyTask, healthyProbe, null)
  }

  for (const provenProbe of healthyLandingProbes(profile, landing)) {
    const provenPlan = planForProbe(provenProbe, null)
    if (provenPlan)
      return provenPlan
  }

  const initialProbe = chooseInitialHopProbe(profile)
  const reused = findTopologyPingTask(profile.tasks, source.uuid, landing, initialProbe)
  const task = reused ?? draftTopologyPingTask(source, landing, initialProbe, profile.tasks)
  return {
    task,
    probe: initialProbe,
    verdict: reused ? assessHopTask(profile, reused) : 'pending',
    needsCreation: !reused,
    exhausted: false,
    switchedFrom: null,
    targetAddress,
    retiredTasks: retire(task.name),
  }
}

export interface EntryProbePlan {
  task: AdminPingTask
  probe: TopologyHopProbe
  verdict: HopTaskVerdict
  needsCreation: boolean
  /** 阶梯已经走完，所有探测方式都判死。 */
  exhausted: boolean
  /** 本次因为判死而从哪种探测方式切换过来；没切换则为 null。 */
  switchedFrom: TopologyHopProbe | null
  /**
   * 名字符合、但不是这次选中绑定的同名任务——多半是换挡时新建成功、旧的还
   * 没删掉留下的，也可能是站长本来就建了不止一个。调用方应该在换挡成功后
   * 尝试清理，但必须先用本会话实际创建的任务 ID 证明所有权，不能仅凭名称
   * 删除；删不掉也不影响主流程，下一轮还会再给出同样的候选。
   */
  retiredTasks: AdminPingTask[]
}

/**
 * 第 1 段只按名字认任务（label / taskFilter / 旧版 Transit-entry-*），不按目标地址。
 * 多个同名任务时绑定健康的那个，其余记入 retiredTasks，避免把「先建后清」误判成缺失。
 */
export async function planEntryProbeTask(
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  options: { fresh?: boolean } = {},
): Promise<EntryProbePlan> {
  if (!source.uuid.trim())
    throw new Error('线路机已失效，请重新选择。')

  const profile = await loadSourceProbeProfile(source.uuid, options)
  const assigned = profile.tasks.filter(task => isPingTaskAssignedToSource(task, source.uuid))
  const candidateNames = entryTaskNameCandidates(probe)
  const candidates = assigned.filter(task => candidateNames.has(normalizePingTaskName(task.name)))

  const draftAt = (hopProbe: TopologyHopProbe, taskName = probe.taskFilter): AdminPingTask => {
    const normalized = normalizeTopologyHopProbe(hopProbe)
    const targetHost = entryProbeTarget(probe, normalized)
    const target = targetHost ? buildTopologyHopTarget({ ipv4: targetHost }, normalized) : ''
    return { name: taskName, type: normalized.type, target, default_on: false, clients: [source.uuid], interval: 30 }
  }

  if (!candidates.length) {
    const initialProbe = chooseInitialHopProbe(profile)
    return {
      task: draftAt(initialProbe),
      probe: initialProbe,
      verdict: 'pending',
      needsCreation: true,
      exhausted: false,
      switchedFrom: null,
      retiredTasks: [],
    }
  }

  // 健康的优先；都不健康时选 id 最大（最近创建）的那个，保证多次重新规划时
  // 结果稳定，不会在候选之间来回摇摆。
  const rank = (task: AdminPingTask): number => {
    const taskVerdict = assessHopTask(profile, task)
    return taskVerdict === 'healthy' ? 2 : taskVerdict === 'pending' ? 1 : 0
  }
  const [existing, ...duplicates] = [...candidates].sort((a, b) => rank(b) - rank(a) || (b.id ?? 0) - (a.id ?? 0))

  const currentProbe = topologyHopProbeFromTask(existing!) ?? DEFAULT_TOPOLOGY_HOP_PROBE
  const verdict = assessHopTask(profile, existing!)
  if (verdict !== 'dead') {
    return {
      task: existing!,
      probe: currentProbe,
      verdict,
      needsCreation: false,
      exhausted: false,
      switchedFrom: null,
      retiredTasks: duplicates,
    }
  }

  const nextRung = nextLadderProbe(profile, currentProbe, candidates)
  const nextProbe = nextRung && entryProbeTarget(probe, nextRung) ? nextRung : null
  if (!nextProbe) {
    return {
      task: existing!,
      probe: currentProbe,
      verdict: 'dead',
      needsCreation: false,
      exhausted: true,
      switchedFrom: null,
      retiredTasks: duplicates,
    }
  }
  return {
    task: draftAt(nextProbe, existing!.name),
    probe: nextProbe,
    verdict: 'pending',
    needsCreation: true,
    exhausted: false,
    switchedFrom: currentProbe,
    retiredTasks: [existing!, ...duplicates],
  }
}
