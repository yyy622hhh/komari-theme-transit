import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskVerdict, SourceProbeProfile } from '@/services/topology-probe-profile.service'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import {
  buildTopologyEntryTarget,
  DEFAULT_TOPOLOGY_HOP_PROBE,
  isPingTaskAssignedToSource,
  normalizeTopologyHopProbe,
  topologyHopProbeFromTask,
} from '@/services/ping-task.service'
import {
  assessHopTask,
  chooseInitialHopProbe,
  CUSTOM_ENTRY_LADDER,
  ENTRY_LADDER,
  LADDER,
  ladderIndex,
  loadSourceProbeProfile,
  nextLadderProbe,
} from '@/services/topology-probe-profile.service'
import { getTopologyProbeTarget, isCustomTopologyProbe, normalizePingTaskName, topologyEntryTaskName } from '@/utils/topologyPresets'

/** 第 1 段（入口）探测任务的规划：只读，不发写请求。 */

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
   * 不是这次选中绑定的旧任务——多半是换挡/改目标时新建成功、旧的还没删掉，
   * 也可能是站长本来就建了不止一个。调用方应该在新绑定保存后尝试清理，但
   * 必须先用本会话实际创建的任务 ID 证明所有权，不能仅凭名称删除。
   */
  retiredTasks: AdminPingTask[]
}

function entryTaskNameCandidates(probe: TopologyProbeOption): Set<string> {
  // 旧版 Transit-entry-* 命名要连第 2 段阶梯的端口一起认：早先入口沿用的就是
  // 那份阶梯，站里可能还留着 tcp-443 之类的旧任务。
  const legacyRungs = [...new Set([...LADDER, ...ENTRY_LADDER])].filter(rung => rung.type === 'tcp')
  return new Set([
    probe.taskFilter,
    ...(isCustomTopologyProbe(probe) ? [] : [probe.label]),
    topologyEntryTaskName(probe, { type: 'icmp' }),
    ...legacyRungs.map(rung => topologyEntryTaskName(probe, rung)),
  ].map(normalizePingTaskName))
}

/**
 * 入口首档：只借用「这台线路机能不能发 ICMP」这一个结论。
 *
 * `chooseInitialHopProbe` 会返回第 2 段阶梯上的端口（443/80/22），那些端口在
 * 运营商测速点上没有意义，必须落回入口阶梯自己的档位。
 */
function entryProbeLadder(probe: TopologyProbeOption): readonly TopologyHopProbe[] {
  return isCustomTopologyProbe(probe) ? CUSTOM_ENTRY_LADDER : ENTRY_LADDER
}

function chooseInitialEntryProbe(profile: SourceProbeProfile, probe: TopologyProbeOption): TopologyHopProbe {
  const initial = chooseInitialHopProbe(profile)
  if (initial.type === 'icmp')
    return initial
  return entryProbeLadder(probe).find(rung => rung.type !== 'icmp') ?? DEFAULT_TOPOLOGY_HOP_PROBE
}

function entryProbeTarget(probe: TopologyProbeOption, hopProbe: TopologyHopProbe): string {
  return getTopologyProbeTarget(probe, hopProbe)
}

/**
 * 第 1 段只按名字认任务（label / taskFilter / 旧版 Transit-entry-*），不按目标地址。
 * 多个同名任务时绑定健康的那个，其余记入 retiredTasks，避免把「先建后清」误判成缺失。
 */
export async function planEntryProbeTask(
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  options: { fresh?: boolean, currentTaskName?: string } = {},
): Promise<EntryProbePlan> {
  if (!source.uuid.trim())
    throw new Error('线路机已失效，请重新选择。')

  const profile = await loadSourceProbeProfile(source.uuid, options)
  const assigned = profile.tasks.filter(task => isPingTaskAssignedToSource(task, source.uuid))
  const candidateNames = entryTaskNameCandidates(probe)
  const candidates = assigned.filter(task => candidateNames.has(normalizePingTaskName(task.name)))
  const currentTaskName = normalizePingTaskName(options.currentTaskName ?? '')
  // 自定义入口换目标后 key 会随目标变化；旧绑定不能继续拿来探新目标，但要交给
  // 上层的“仅删除本会话自建任务”机制回收，避免反复修改目标积累孤儿任务。
  const obsoleteCustomBindings = isCustomTopologyProbe(probe) && currentTaskName && !candidateNames.has(currentTaskName)
    ? assigned.filter(task => normalizePingTaskName(task.name) === currentTaskName)
    : []

  const draftAt = (hopProbe: TopologyHopProbe, taskName = probe.taskFilter): AdminPingTask => {
    const normalized = normalizeTopologyHopProbe(hopProbe)
    const targetHost = entryProbeTarget(probe, normalized)
    const target = targetHost ? buildTopologyEntryTarget(targetHost, normalized) : ''
    return { name: taskName, type: normalized.type, target, default_on: false, clients: [source.uuid], interval: 30 }
  }

  if (!candidates.length) {
    const initialProbe = chooseInitialEntryProbe(profile, probe)
    return {
      task: draftAt(initialProbe),
      probe: initialProbe,
      verdict: 'pending',
      needsCreation: true,
      exhausted: false,
      switchedFrom: null,
      retiredTasks: obsoleteCustomBindings,
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
  const currentName = normalizePingTaskName(existing!.name)
  const sameNamedCandidates = candidates.filter(task => normalizePingTaskName(task.name) === currentName)
  const generatedCurrentName = topologyEntryTaskName(probe, currentProbe)
  const generatedCurrentCandidates = candidates.filter(task => normalizePingTaskName(task.name) === normalizePingTaskName(generatedCurrentName))

  // v1.3.3 以前自定义入口换挡仍沿用同一个基础名。若升级时阶梯已经走到最后
  // 一档，下面的 exhausted 分支不会再触发“换下一档”，于是两个同名旧任务会
  // 永久留在配置里，按名称绑定也无法确定读哪一个。先把当前档迁移到带协议/
  // 端口的精确名称；即使旧任务不属于本会话、不能安全删除，新绑定也不再歧义。
  if (isCustomTopologyProbe(probe)
    && sameNamedCandidates.length > 1
    && currentName !== normalizePingTaskName(generatedCurrentName)) {
    const reusable = generatedCurrentCandidates.length === 1 ? generatedCurrentCandidates[0] : null
    return {
      task: reusable ?? draftAt(currentProbe, generatedCurrentName),
      probe: currentProbe,
      verdict: reusable ? assessHopTask(profile, reusable) : 'pending',
      needsCreation: reusable === null,
      exhausted: false,
      switchedFrom: null,
      retiredTasks: [existing!, ...duplicates, ...obsoleteCustomBindings]
        .filter(task => task !== reusable),
    }
  }
  if (verdict !== 'dead') {
    return {
      task: existing!,
      probe: currentProbe,
      verdict,
      needsCreation: false,
      exhausted: false,
      switchedFrom: null,
      retiredTasks: [...duplicates, ...obsoleteCustomBindings],
    }
  }

  const ladder = entryProbeLadder(probe)
  // v1.3.2 曾把自定义地址误当运营商 DNS，ICMP 失败后会留下 TCP 53 任务。
  // 53 不在新的自定义阶梯中；已判死时直接迁移到首个常见 TCP 档，不重试 ICMP。
  const nextRung = isCustomTopologyProbe(probe) && ladderIndex(currentProbe, ladder) < 0
    ? nextLadderProbe(profile, DEFAULT_TOPOLOGY_HOP_PROBE, candidates, ladder)
    : nextLadderProbe(profile, currentProbe, candidates, ladder)
  const nextProbe = nextRung && entryProbeTarget(probe, nextRung) ? nextRung : null
  if (!nextProbe) {
    if (isCustomTopologyProbe(probe) && currentName !== normalizePingTaskName(generatedCurrentName)) {
      const reusable = generatedCurrentCandidates.length === 1 ? generatedCurrentCandidates[0] : null
      return {
        task: reusable ?? draftAt(currentProbe, generatedCurrentName),
        probe: currentProbe,
        verdict: reusable ? assessHopTask(profile, reusable) : 'pending',
        needsCreation: reusable === null,
        exhausted: false,
        switchedFrom: null,
        retiredTasks: [existing!, ...duplicates, ...obsoleteCustomBindings]
          .filter(task => task !== reusable),
      }
    }
    return {
      task: existing!,
      probe: currentProbe,
      verdict: 'dead',
      needsCreation: false,
      exhausted: true,
      switchedFrom: null,
      retiredTasks: obsoleteCustomBindings,
    }
  }
  // 内置入口继续复用“北京电信”这类固定任务名；自定义入口换挡必须使用带协议/
  // 端口的唯一名称。旧自定义任务可能来自升级前、另一个标签页或另一位管理员，
  // 当前会话没有所有权时不能安全删除。若新旧任务仍同名，保存后的绑定只能按名
  // 命中多个任务，旧的 TCP 53 会继续污染采样；唯一名称让新任务即使与旧任务
  // 并存，也能被拓扑精确绑定和继续走完 443 -> 80 -> 22 阶梯。
  const replacementTaskName = isCustomTopologyProbe(probe)
    ? topologyEntryTaskName(probe, nextProbe)
    : existing!.name
  return {
    task: draftAt(nextProbe, replacementTaskName),
    probe: nextProbe,
    verdict: 'pending',
    needsCreation: true,
    exhausted: false,
    switchedFrom: currentProbe,
    retiredTasks: [existing!, ...duplicates, ...obsoleteCustomBindings],
  }
}
