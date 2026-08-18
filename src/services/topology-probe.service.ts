import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { PingMetricTaskStats } from '@/utils/rpc'
import { OPS_TOPOLOGY_HOP_PROBE, OPS_TOPOLOGY_HOP_PROBE_LADDER } from '@/constants/ops'
import { loadPingMetricStats } from '@/services/metrics.service'
import {
  DEFAULT_TOPOLOGY_HOP_PROBE,
  draftTopologyPingTask,
  findTopologyPingTask,
  findTopologyPingTaskByName,
  isPingTaskAssignedToSource,
  isSameTopologyHopProbe,
  listTopologyPingTasks,
  loadAdminPingTasks,
  normalizeTopologyHopProbe,
  topologyHopProbeFromTask,
  topologyHopTaskNameCandidates,
  topologyPingTargets,
} from '@/services/ping-task.service'

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

/** 拉齐这台线路机上所有任务的类型、目标和最近采样情况。 */
export async function loadSourceProbeProfile(sourceUuid: string): Promise<SourceProbeProfile> {
  const [tasks, stats] = await Promise.all([
    loadAdminPingTasks(),
    loadPingMetricStats({
      entity_ids: [sourceUuid],
      hours: OPS_TOPOLOGY_HOP_PROBE.lookbackHours,
    }).catch(() => null),
  ])

  const samplesByTaskId = new Map<string, HopTaskSamples>()
  const samplesByTaskName = new Map<string, HopTaskSamples>()
  for (const stat of stats?.stats ?? []) {
    if (stat.entity_id !== sourceUuid)
      continue
    const samples = readSamples(stat)
    samplesByTaskId.set(String(stat.task_id).trim(), samples)
    const name = stat.name?.trim()
    if (name)
      samplesByTaskName.set(name, samples)
  }

  return { sourceUuid, tasks, samplesByTaskId, samplesByTaskName }
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
): Promise<HopTaskPlan> {
  if (!source.uuid.trim() || !landing.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  const targetAddress = topologyPingTargets(landing)[0] ?? ''
  if (!targetAddress)
    throw new Error(`落地机“${landing.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)

  const profile = await loadSourceProbeProfile(source.uuid)
  const hopTasks = listTopologyPingTasks(profile.tasks, source.uuid, landing)
  // 只有当按名字认回来的任务确实指向当前落地机时才认它。绑错落地机或落地机被
  // 改过时，仍然按地址重新推导，让主题自己纠正。
  const named = findTopologyPingTaskByName(profile.tasks, source.uuid, currentTaskName)
  const bound = (named && hopTasks.some(task => task.name === named.name) ? named : undefined)
    ?? findTopologyPingTask(profile.tasks, source.uuid, landing)

  const retire = (selectedTaskName: string) => collectRetiredTasks(profile, source, landing, hopTasks, selectedTaskName)

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
    const reused = findTopologyPingTask(profile.tasks, source.uuid, landing, nextProbe)
    const task = reused ?? draftTopologyPingTask(source, landing, nextProbe, profile.tasks)
    return {
      task,
      probe: nextProbe,
      verdict: reused ? assessHopTask(profile, reused) : 'pending',
      needsCreation: !reused,
      exhausted: false,
      switchedFrom: boundProbe,
      targetAddress,
      retiredTasks: retire(task.name),
    }
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
