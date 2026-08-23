import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskSamples, HopTaskVerdict, SourceProbeProfile } from '@/services/topology-probe-profile.service'
import {
  DEFAULT_TOPOLOGY_HOP_PROBE,
  draftTopologyPingTask,
  findTopologyPingTask,
  findTopologyPingTaskByName,
  isSameTopologyHopProbe,
  listTopologyPingTasks,
  pingTaskTargetHost,
  topologyHopProbeFromTask,
  topologyHopTaskNameCandidates,
  topologyPingTargets,
} from '@/services/ping-task.service'
import { assessHopTask, chooseInitialHopProbe, LADDER, loadSourceProbeProfile, nextLadderProbe } from '@/services/topology-probe-profile.service'

/** 第 2 段（线路机 → 落地机）探测任务的规划：只读，不发写请求。 */

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
