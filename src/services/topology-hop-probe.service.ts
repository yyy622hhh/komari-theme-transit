import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskSamples, HopTaskVerdict, SourceProbeProfile } from '@/services/topology-probe-profile.service'
import {
  DEFAULT_TOPOLOGY_HOP_PROBE,
  draftTopologyPingTask,
  findTopologyPingTaskByName,
  isPingTaskAssignedToSource,
  isSameTopologyHopProbe,
  listTopologyPingTasks,
  pingTaskTargetHost,
  topologyHopProbeFromTask,
  topologyHopTaskName,
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
 * ICMP 还要和本源能力求交：本机已经证明发不出 ICMP 时，不能因为别的线路机
 * ping 得通就把本源已经删掉的 ICMP 任务再建模回来。
 */
function healthyLandingProbes(
  profile: SourceProbeProfile,
  source: TopologyPingEndpoint,
  landing: TopologyPingEndpoint,
  allowedProbes: readonly TopologyHopProbe[] | null,
): TopologyHopProbe[] {
  const targetHosts = new Set(topologyPingTargets(landing))
  const icmpOnly = allowedProbes?.length === 1 && allowedProbes[0]?.type === 'icmp'
  const skipIcmp = !icmpOnly && chooseInitialHopProbe(profile).type !== 'icmp'
  const probes: TopologyHopProbe[] = []
  for (const task of profile.tasks) {
    if (!targetHosts.has(pingTaskTargetHost(task.target)))
      continue
    if ((getObservedTaskSamples(profile, task)?.valid ?? 0) <= 0)
      continue
    const probe = topologyHopProbeFromTask(task)
    if (!probe || probes.some(existing => isSameTopologyHopProbe(existing, probe)))
      continue
    // 第 2 段只展示 Ping 与丢包率。其它来源即使证明某个 TCP 端口能连，也不能
    // 把当前线路降级成“连接失败率”。
    if (allowedProbes && !allowedProbes.some(rung => isSameTopologyHopProbe(rung, probe)))
      continue
    if (skipIcmp && probe.type === 'icmp')
      continue
    const learnedHost = pingTaskTargetHost(task.target)
    const localSameHost = profile.tasks.filter((candidate) => {
      if (!isPingTaskAssignedToSource(candidate, source.uuid))
        return false
      if (pingTaskTargetHost(candidate.target) !== learnedHost)
        return false
      const candidateProbe = topologyHopProbeFromTask(candidate)
      return candidateProbe !== null && isSameTopologyHopProbe(candidateProbe, probe)
    })
    if (localSameHost.length && localSameHost.every(task => assessHopTask(profile, task) === 'dead'))
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
  const base = topologyHopTaskName(source, landing)
  return name === base || name.startsWith(`${base}-`)
}

function landingForProbe(
  landing: TopologyPingEndpoint,
  profile: SourceProbeProfile,
  source: TopologyPingEndpoint,
  probe: TopologyHopProbe,
): TopologyPingEndpoint {
  const hosts = topologyPingTargets(landing)
  if (hosts.length <= 1)
    return landing
  const v4Host = hosts[0]!
  const localV4 = profile.tasks.filter((candidate) => {
    if (!isPingTaskAssignedToSource(candidate, source.uuid))
      return false
    if (pingTaskTargetHost(candidate.target) !== v4Host)
      return false
    const candidateProbe = topologyHopProbeFromTask(candidate)
    return candidateProbe !== null && isSameTopologyHopProbe(candidateProbe, probe)
  })
  if (localV4.length && localV4.every(task => assessHopTask(profile, task) === 'dead'))
    return { ...landing, ipv4: undefined }
  return landing
}

function collectRetiredTasks(
  profile: SourceProbeProfile,
  source: TopologyPingEndpoint,
  landing: TopologyPingEndpoint,
  hopTasks: readonly AdminPingTask[],
  selectedTask: AdminPingTask,
): AdminPingTask[] {
  return hopTasks.filter((task) => {
    const selected = Number.isInteger(task.id) && Number.isInteger(selectedTask.id)
      ? task.id === selectedTask.id
      : task === selectedTask
    if (selected || !Number.isInteger(task.id))
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
  options: { fresh?: boolean, icmpOnly?: boolean } = {},
): Promise<HopTaskPlan> {
  if (!source.uuid.trim() || !landing.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  const targetAddress = topologyPingTargets(landing)[0] ?? ''
  if (!targetAddress)
    throw new Error(`落地机“${landing.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)

  const addressOf = (task?: Pick<AdminPingTask, 'target'>, endpoint: TopologyPingEndpoint = landing) =>
    (task ? pingTaskTargetHost(task.target) : '') || topologyPingTargets(endpoint)[0] || targetAddress
  const profile = await loadSourceProbeProfile(source.uuid, options)
  const probeLadder: readonly TopologyHopProbe[] = options.icmpOnly
    ? [DEFAULT_TOPOLOGY_HOP_PROBE]
    : LADDER
  const isAllowedHopProbe = (probe: TopologyHopProbe) => !options.icmpOnly
    || probeLadder.some(rung => isSameTopologyHopProbe(rung, probe))
  const hopTasks = listTopologyPingTasks(profile.tasks, source.uuid, landing)
  const verdictRank: Record<HopTaskVerdict, number> = { healthy: 0, pending: 1, missing: 1, dead: 2 }
  const preferredTask = (tasks: readonly AdminPingTask[]): AdminPingTask | undefined => {
    const ranked = tasks
      .map((task, index) => ({ task, index, rank: verdictRank[assessHopTask(profile, task)] }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
    return ranked[0]?.task
  }
  // 只有当按名字认回来的任务确实指向当前落地机时才认它。绑错落地机或落地机被
  // 改过时，仍然按地址重新推导，让主题自己纠正。
  const named = findTopologyPingTaskByName(profile.tasks, source.uuid, currentTaskName)
  const namedCandidates = currentTaskName.trim()
    ? hopTasks.filter(task => task.name.trim() === currentTaskName.trim())
    : []
  const legacyIcmpCandidates = hopTasks.filter((task) => {
    const probe = topologyHopProbeFromTask(task)
    return probe !== null && isSameTopologyHopProbe(probe, DEFAULT_TOPOLOGY_HOP_PROBE)
  })
  const bound = (named && hopTasks.some(task => task.id === named.id) ? named : undefined)
    ?? preferredTask(namedCandidates)
    // 旧版没有 taskFilter 时只会按落地地址认回 ICMP；其它协议仍由
    // chooseInitialHopProbe/planForProbe 规划，否则一个旧的死 TCP 任务会阻止双栈落地改试 IPv6。
    ?? preferredTask(legacyIcmpCandidates)

  const retire = (selectedTask: AdminPingTask) => collectRetiredTasks(profile, source, landing, hopTasks, selectedTask)
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
    targetAddress: addressOf(task),
    retiredTasks: retire(task),
  })
  const planForProbe = (
    probe: TopologyHopProbe,
    switchedFrom: TopologyHopProbe | null,
  ): HopTaskPlan | null => {
    const endpoint = landingForProbe(landing, profile, source, probe)
    const sameProbeTasks = listTopologyPingTasks(profile.tasks, source.uuid, endpoint).filter((task) => {
      const taskProbe = topologyHopProbeFromTask(task)
      return taskProbe !== null && isSameTopologyHopProbe(taskProbe, probe)
    })
    const reused = preferredTask(sameProbeTasks)
    if (reused && assessHopTask(profile, reused) === 'dead')
      return null
    if (reused)
      return planForTask(reused, probe, switchedFrom)
    const task = draftTopologyPingTask(source, endpoint, probe, profile.tasks)
    return {
      task,
      probe,
      verdict: 'pending',
      needsCreation: true,
      exhausted: false,
      switchedFrom,
      targetAddress: addressOf(task, endpoint),
      retiredTasks: retire(task),
    }
  }
  const existingHealthy = (excluded?: AdminPingTask): AdminPingTask | undefined => hopTasks.find((task) => {
    if (assessHopTask(profile, task) !== 'healthy')
      return false
    const probe = topologyHopProbeFromTask(task)
    if (!probe || !isAllowedHopProbe(probe))
      return false
    if (excluded && Number.isInteger(excluded.id) && Number.isInteger(task.id))
      return task.id !== excluded.id
    return task !== excluded
  })

  if (bound) {
    const boundProbe = topologyHopProbeFromTask(bound) ?? DEFAULT_TOPOLOGY_HOP_PROBE
    // 旧版本可能把后半段自动降级成 TCP。新策略必须迁回 ICMP，不能因为旧 TCP
    // 当前健康就继续展示“连接失败率”。若已经有 ICMP 任务则直接认回（即便它
    // 正在显示 100% 丢包），否则创建一条独立任务并写回新绑定。
    if (options.icmpOnly && !isAllowedHopProbe(boundProbe)) {
      const preferredProbe = probeLadder[0] ?? DEFAULT_TOPOLOGY_HOP_PROBE
      const existingPreferred = preferredTask(hopTasks.filter((task) => {
        const probe = topologyHopProbeFromTask(task)
        return probe !== null && isSameTopologyHopProbe(probe, preferredProbe)
      }))
      if (existingPreferred) {
        const plan = planForTask(existingPreferred, preferredProbe, boundProbe)
        return { ...plan, exhausted: plan.verdict === 'dead' }
      }
      const endpoint = landingForProbe(landing, profile, source, preferredProbe)
      const task = draftTopologyPingTask(source, endpoint, preferredProbe, profile.tasks)
      return {
        task,
        probe: preferredProbe,
        verdict: 'pending',
        needsCreation: true,
        exhausted: false,
        switchedFrom: boundProbe,
        targetAddress: addressOf(task, endpoint),
        retiredTasks: retire(task),
      }
    }
    const verdict = assessHopTask(profile, bound)
    if (verdict !== 'dead') {
      return {
        task: bound,
        probe: boundProbe,
        verdict,
        needsCreation: false,
        exhausted: false,
        switchedFrom: null,
        targetAddress: addressOf(bound),
        retiredTasks: retire(bound),
      }
    }

    const healthyTask = existingHealthy(bound)
    if (healthyTask) {
      const healthyProbe = topologyHopProbeFromTask(healthyTask) ?? DEFAULT_TOPOLOGY_HOP_PROBE
      return planForTask(healthyTask, healthyProbe, boundProbe)
    }

    for (const provenProbe of healthyLandingProbes(profile, source, landing, options.icmpOnly ? probeLadder : null)) {
      const provenPlan = planForProbe(provenProbe, boundProbe)
      if (provenPlan)
        return provenPlan
    }

    const nextProbe = nextLadderProbe(profile, boundProbe, hopTasks, probeLadder)
    if (!nextProbe) {
      return {
        task: bound,
        probe: boundProbe,
        verdict: 'dead',
        needsCreation: false,
        exhausted: true,
        switchedFrom: null,
        targetAddress: addressOf(bound),
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

  for (const provenProbe of healthyLandingProbes(profile, source, landing, options.icmpOnly ? probeLadder : null)) {
    const provenPlan = planForProbe(provenProbe, null)
    if (provenPlan)
      return provenPlan
  }

  const initialProbe = options.icmpOnly ? DEFAULT_TOPOLOGY_HOP_PROBE : chooseInitialHopProbe(profile)
  const initialPlan = planForProbe(initialProbe, null)
  if (initialPlan)
    return initialPlan
  const nextProbe = nextLadderProbe(profile, initialProbe, hopTasks, probeLadder)
  if (nextProbe) {
    const nextPlan = planForProbe(nextProbe, initialProbe)
    if (nextPlan)
      return nextPlan
  }
  const initialLanding = landingForProbe(landing, profile, source, initialProbe)
  const task = draftTopologyPingTask(source, initialLanding, initialProbe, profile.tasks)
  return {
    task,
    probe: initialProbe,
    verdict: 'pending',
    needsCreation: true,
    exhausted: false,
    switchedFrom: null,
    targetAddress: addressOf(task, initialLanding),
    retiredTasks: retire(task),
  }
}
