import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { EntryProbePlan, HopTaskPlan } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { isStaleManagedThemeSettingsError } from '@/services/theme-settings.service'
import { getTopologyRouteEntryProbe, resolveTopologyNode, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'
import { recordTopologyWrite, summarizeTaskNames } from '@/utils/topologyWriteLog'

/**
 * `useTopologyManager()` 的最小切面：只暴露自愈流程需要读写的部分，且用取值
 * 器代替 Ref，让测试可以传入普通对象而不必启动 Vue/Pinia。
 */
export interface TopologyRepairManagerLike {
  readonly routes: TopologyRouteConfig[]
  readonly validationErrors: readonly string[]
  readonly dirty: boolean
  reset: () => void
  withSaveLock: <T>(save: () => Promise<T>) => Promise<T>
  preflightSave: () => Promise<void>
  save: (options?: { lockHeld?: boolean }) => Promise<'invalid' | 'saved' | 'changed'>
}

export interface TopologyRepairDeps {
  nodes: () => readonly NodeData[]
  /** 是否允许本轮修复运行；每一步之间都要重新检查，因为对话框可能中途被打开。 */
  canRepair: () => boolean
  requireLoginPermission: () => Promise<boolean>
  manager: TopologyRepairManagerLike
  planWorkingHopTask: (
    source: TopologyPingEndpoint,
    landing: TopologyPingEndpoint,
    currentTaskName?: string,
    options?: { fresh?: boolean },
  ) => Promise<HopTaskPlan>
  ensureTopologyPingTask: (
    source: TopologyPingEndpoint,
    landing: TopologyPingEndpoint,
    options: { probe: TopologyHopProbe, signal?: AbortSignal },
  ) => Promise<{ task: AdminPingTask, created: boolean }>
  deleteTopologyPingTasks: (taskIds: readonly number[]) => Promise<boolean>
  /**
   * 本页会话里 `ensure` 明确 created=true 的任务 ID。跨自愈轮次保留，用来证明
   * 所有权；不能只凭 Transit 命名去删站长自己建的任务。
   */
  sessionCreatedTaskIds?: Set<number>
  planEntryProbeTask: (
    source: TopologyPingEndpoint,
    probe: TopologyProbeOption,
    options?: { fresh?: boolean, currentTaskName?: string },
  ) => Promise<EntryProbePlan>
  ensureTopologyEntryProbeTask: (
    source: TopologyPingEndpoint,
    probe: TopologyProbeOption,
    options?: { hopProbe?: TopologyHopProbe, signal?: AbortSignal, taskName?: string },
  ) => Promise<{ task: AdminPingTask, created: boolean }>
  /** 换挡专用：不查是否已存在同名任务，直接新建，见 `ping-task.service.ts`。 */
  createTopologyEntryProbeTask: (
    source: TopologyPingEndpoint,
    probe: TopologyProbeOption,
    hopProbe: TopologyHopProbe,
    options?: { signal?: AbortSignal, taskName?: string },
  ) => Promise<AdminPingTask>
  signal?: AbortSignal
}

export interface TopologyRetiredTask {
  id: number
  name: string
}

export function liveTopologyTaskNames(routes: readonly Pick<TopologyRouteConfig, 'metrics'>[]): Set<string> {
  return new Set(routes.flatMap(route => route.metrics
    .filter(metric => metric.live)
    .map(metric => metric.taskFilter.trim())
    .filter(Boolean)))
}

/** 只删本会话创建、且当前没有线路再绑定的探测任务。 */
export function listOwnedRetiredTaskIds(
  retired: readonly TopologyRetiredTask[],
  sessionCreatedIds: ReadonlySet<number>,
  boundTaskNames: ReadonlySet<string>,
): number[] {
  return [...new Set(retired
    .filter(task => sessionCreatedIds.has(task.id) && !boundTaskNames.has(task.name.trim()))
    .map(task => task.id))]
}

/**
 * 对照当前任务列表：主题建过、但已经没有任何线路绑定的任务。
 * 用来清掉换入口后留下的「北京电信」之类，不依赖规划阶段有没有记下 retired。
 */
export function listOwnedUnboundTaskIds(
  ownedIds: ReadonlySet<number>,
  tasks: ReadonlyArray<{ id?: number, name: string }>,
  boundTaskNames: ReadonlySet<string>,
): number[] {
  const namesById = new Map<number, string>()
  for (const task of tasks) {
    if (!Number.isInteger(task.id))
      continue
    namesById.set(task.id!, task.name.trim())
  }
  return [...ownedIds].filter((id) => {
    const name = namesById.get(id)
    return Boolean(name) && !boundTaskNames.has(name!)
  })
}

function ownedRetiredTasks(tasks: ReadonlyArray<{ id?: number, name: string }>): TopologyRetiredTask[] {
  return tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
}

export interface TopologyRepairAvailability {
  /** 组件已卸载，effect scope 已停止。 */
  disposed: boolean
  /** 站长通过主题设置关掉了无人值守自愈；关掉后只剩对话框里的手动操作。 */
  autoRepairEnabled: boolean
  /** 拓扑管理对话框正打开——操作者在手动编辑时，后台自愈让路。 */
  managerOpen: boolean
  /** 对应 appStore.privateFeaturesAllowed：只有已登录管理员才能触发写操作。 */
  privateFeaturesAllowed: boolean
  /** appStore.topologyRoute：还没配置任何线路时没什么可修的。 */
  topologyRoute: string
  /** 标签页在后台时没人看结果，也不需要发起写操作；恢复可见后由调用方立即重查一次。 */
  pageVisible: boolean
}

/** 是否可以跑一轮自愈。抽成纯函数，每个分支各自独立可测，不需要 Pinia。 */
export function canRunTopologyProbeRepair(state: TopologyRepairAvailability): boolean {
  return !state.disposed
    && state.autoRepairEnabled
    && !state.managerOpen
    && state.privateFeaturesAllowed
    && Boolean(state.topologyRoute.trim())
    && state.pageVisible
}

export type TopologyRepairOutcome = 'skipped' | 'no-op' | 'repaired'

interface PlannedProbeRepair {
  route: TopologyRouteConfig
  segmentIndex: number
  source: NodeData
  landing: NodeData
  probe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
  retiredTasks: TopologyRetiredTask[]
}

interface PlannedEntryRepair {
  route: TopologyRouteConfig
  source: NodeData
  probe: TopologyProbeOption
  hopProbe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
  /** 换挡（判死后改用别的探测方式）时为真：必须无条件新建，不能按名字找到就复用。 */
  forceCreate: boolean
  /** 名字符合但不是这次绑定的同名任务，绑定成功后按会话所有权尝试清理。 */
  retiredTasks: AdminPingTask[]
}

/**
 * 后台自愈第 2 段绑定：给失效的探测绑定切换到已验证可用的任务/端口，仅在权限
 * 、锁和校验全部通过时才落盘。是唯一一处「无人值守自动写后端」的逻辑，因此
 * 拆成纯函数以便完整测试每一个提前退出分支。
 */
export async function runTopologyProbeRepair(deps: TopologyRepairDeps): Promise<TopologyRepairOutcome> {
  const canContinue = () => deps.canRepair() && !deps.signal?.aborted
  if (!canContinue())
    return 'skipped'

  const granted = await deps.requireLoginPermission()
  if (!granted || !canContinue())
    return 'skipped'

  deps.manager.reset()
  if (deps.manager.validationErrors.length)
    return 'skipped'

  const sessionCreatedTaskIds = deps.sessionCreatedTaskIds ?? new Set<number>()

  async function planRouteRepair(route: TopologyRouteConfig, segmentIndex: number, options: { fresh?: boolean } = {}): Promise<PlannedProbeRepair | null> {
    // 配置里带着 uuid，节点在 Komari 里改过名也认得回来。
    const source = resolveTopologyNode(deps.nodes(), route.nodes[segmentIndex]?.name ?? '', route.nodes[segmentIndex]?.uuid ?? '')
    const landing = resolveTopologyNode(deps.nodes(), route.nodes[segmentIndex + 1]?.name ?? '', route.nodes[segmentIndex + 1]?.uuid ?? '')
    const metric = route.metrics[segmentIndex]
    if (!source || !landing || !metric?.live)
      return null
    // 离线节点不产生样本，`assessHopTask` 无法区分"这种探测方式被封"和"落地机
    // 挂了"。不加这道闸，一次十分钟的宕机就会把整条探测阶梯走完，留下一串谁也
    // 不会清理的 Ping 任务，并把主题配置重写好几遍。
    if (source.online === false || landing.online === false)
      return null

    const planned = await deps.planWorkingHopTask(source, landing, metric.taskFilter, options)
    const renamed = route.nodes[segmentIndex]?.name.trim() !== source.name.trim()
      || route.nodes[segmentIndex + 1]?.name.trim() !== landing.name.trim()
    const bindingChanged = metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== planned.task.name.trim()
    if (!planned.needsCreation && !bindingChanged && !renamed)
      return null

    return {
      route,
      segmentIndex,
      source,
      landing,
      probe: planned.probe,
      taskName: planned.task.name,
      needsCreation: planned.needsCreation,
      retiredTasks: ownedRetiredTasks(planned.retiredTasks),
    }
  }

  /** 入口段：绑定规划出的真实任务名，换挡先建后清。 */
  async function planEntryRepair(route: TopologyRouteConfig, options: { fresh?: boolean } = {}): Promise<PlannedEntryRepair | null> {
    const source = resolveTopologyNode(deps.nodes(), route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
    if (!source)
      return null
    // 离线线路机发不出样本，判死会走空整条阶梯，理由同第 2 段。
    if (source.online === false)
      return null
    const probe = getTopologyRouteEntryProbe(route)
    const customEntry = Boolean(route.nodes[0]?.probeTarget?.trim())
    if (!probe || (!customEntry && !shouldAutoApplyTopologyProbe(route)))
      return null
    const metric = route.metrics[0]

    const plan = await deps.planEntryProbeTask(source, probe, {
      ...options,
      currentTaskName: metric?.taskFilter,
    })
    if (plan.exhausted)
      return null

    const taskName = plan.task.name.trim() || probe.taskFilter
    const renamed = route.nodes[1]?.name.trim() !== source.name.trim()
    const bindingChanged = !metric?.live
      || metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== taskName
    const hasCleanableRetirement = plan.retiredTasks
      .some(task => Number.isInteger(task.id) && sessionCreatedTaskIds.has(task.id!))
    if (!plan.needsCreation && !bindingChanged && !renamed && !hasCleanableRetirement)
      return null

    return {
      route,
      source,
      probe,
      hopProbe: plan.probe,
      taskName,
      needsCreation: plan.needsCreation,
      forceCreate: plan.switchedFrom !== null,
      retiredTasks: plan.retiredTasks,
    }
  }

  const [repairs, entryRepairs] = await Promise.all([
    Promise.all(deps.manager.routes.flatMap(route => Array.from(
      { length: Math.max(0, route.nodes.filter(node => node.name.trim()).length - 2) },
      (_, index) => planRouteRepair(route, index + 1).catch(() => null),
    )))
      .then(list => list.filter((repair): repair is PlannedProbeRepair => repair !== null)),
    Promise.all(deps.manager.routes.map(route => planEntryRepair(route).catch(() => null)))
      .then(list => list.filter((repair): repair is PlannedEntryRepair => repair !== null)),
  ])
  if ((!repairs.length && !entryRepairs.length) || !canContinue())
    return 'no-op'

  let outcome: TopologyRepairOutcome = 'no-op'
  const createdTaskIds = new Set<number>()
  /** 用于流水记录：本轮实际建过哪些任务，按名字记，操作者在 Komari 里看到的就是名字。 */
  const createdTaskNames: string[] = []
  const appliedRetiredTasks: TopologyRetiredTask[] = []
  let saveAttempted = false
  let bindingPersisted = false
  try {
    await deps.manager.withSaveLock(async () => {
      if (!canContinue())
        return
      try {
        await deps.manager.preflightSave()
      }
      catch (error) {
        // GET 已经通过 onPublicSettings 把权威值写回 store。这里 reset 一次，
        // 下一轮按新快照规划；不要把本轮按陈旧线路算好的补丁写上去。
        if (isStaleManagedThemeSettingsError(error)) {
          deps.manager.reset()
          return
        }
        throw error
      }
      if (!canContinue())
        return

      for (const repair of repairs) {
        if (!canContinue())
          return
        // 锁内重新规划一次：另一个标签页可能已经在拿到锁之前改了这条线路。必须
        // 绕过任务列表缓存，否则这一次读到的还是拿锁前的同一份快照，等于没查。
        // 和锁外那遍一样要吞掉单条线路的失败：这里抛出会穿过 withSaveLock 直达
        // finally，把本轮为**其他**线路刚建好的任务一并删掉，然后下一轮重建、
        // 再删——只要有一条线路持续失败，就是一个建删循环。
        const latestRepair = await planRouteRepair(repair.route, repair.segmentIndex, { fresh: true }).catch(() => null)
        if (!latestRepair)
          continue
        const metric = latestRepair.route.metrics[latestRepair.segmentIndex]
        if (!metric?.live)
          continue
        let taskName = latestRepair.taskName
        if (latestRepair.needsCreation) {
          try {
            const ensured = await deps.ensureTopologyPingTask(latestRepair.source, latestRepair.landing, {
              probe: latestRepair.probe,
              signal: deps.signal,
            })
            taskName = ensured.task.name
            if (ensured.created && Number.isInteger(ensured.task.id)) {
              createdTaskIds.add(ensured.task.id!)
              createdTaskNames.push(ensured.task.name)
              sessionCreatedTaskIds.add(ensured.task.id!)
            }
          }
          catch {
            // 单条建任务失败不能掀翻整轮：否则 finally 会把已经建好的其他线路任务删掉。
            if (!canContinue())
              return
            continue
          }
        }
        if (!canContinue())
          return
        // 节点改名后把线路本身也校正到新名称，收敛回按名称匹配的快路径；否则
        // 探测任务修好了，图上和下次打开管理器时看到的仍然是改名前的旧名字。
        if (latestRepair.route.nodes[latestRepair.segmentIndex])
          latestRepair.route.nodes[latestRepair.segmentIndex]!.name = latestRepair.source.name
        if (latestRepair.route.nodes[latestRepair.segmentIndex + 1])
          latestRepair.route.nodes[latestRepair.segmentIndex + 1]!.name = latestRepair.landing.name
        metric.nodeName = latestRepair.source.name
        metric.taskFilter = taskName
        appliedRetiredTasks.push(...latestRepair.retiredTasks)
      }

      for (const repair of entryRepairs) {
        if (!canContinue())
          return
        // 同样在锁内重新规划一次，理由与第 2 段一致。
        const latestEntryRepair = await planEntryRepair(repair.route, { fresh: true })
        if (!latestEntryRepair)
          continue
        const metric = latestEntryRepair.route.metrics[0]
        if (!metric)
          continue
        let taskName = latestEntryRepair.taskName
        if (latestEntryRepair.needsCreation) {
          const ensured = latestEntryRepair.forceCreate
            ? { task: await deps.createTopologyEntryProbeTask(latestEntryRepair.source, latestEntryRepair.probe, latestEntryRepair.hopProbe, { signal: deps.signal, taskName: latestEntryRepair.taskName }), created: true }
            : await deps.ensureTopologyEntryProbeTask(latestEntryRepair.source, latestEntryRepair.probe, {
                hopProbe: latestEntryRepair.hopProbe,
                signal: deps.signal,
                taskName: latestEntryRepair.taskName,
              })
          taskName = ensured.task.name
          if (ensured.created && Number.isInteger(ensured.task.id)) {
            createdTaskIds.add(ensured.task.id!)
            createdTaskNames.push(ensured.task.name)
            sessionCreatedTaskIds.add(ensured.task.id!)
          }
        }
        if (!canContinue())
          return
        if (latestEntryRepair.route.nodes[1])
          latestEntryRepair.route.nodes[1].name = latestEntryRepair.source.name
        metric.nodeName = latestEntryRepair.source.name
        metric.taskFilter = taskName
        metric.live = true

        const retirableIds = latestEntryRepair.retiredTasks
          .filter(task => Number.isInteger(task.id) && sessionCreatedTaskIds.has(task.id!))
          .map(task => task.id!)
        if (retirableIds.length && await deps.deleteTopologyPingTasks(retirableIds)) {
          for (const id of retirableIds)
            sessionCreatedTaskIds.delete(id)
        }
      }

      if (deps.manager.dirty && canContinue()) {
        // Task creation is a separate RPC from the theme save. Recheck auth and
        // the expected topology snapshot once more before starting the write;
        // if this fails, the finally block can safely remove tasks created above.
        await deps.manager.preflightSave()
        if (!canContinue())
          return
        saveAttempted = true
        try {
          const result = await deps.manager.save({ lockHeld: true })
          if (result === 'saved' || result === 'changed') {
            outcome = 'repaired'
            bindingPersisted = true
          }
          else {
            saveAttempted = false
          }
        }
        catch (error) {
          // If the old expected snapshot is still current, the save definitely
          // did not persist and newly created tasks are safe to remove. If this
          // check fails, persistence is ambiguous; preserve the task because a
          // successful POST followed by a failed verification may already bind it.
          try {
            await deps.manager.preflightSave()
            saveAttempted = false
          }
          catch {
          }
          throw error
        }
      }
      else if (!deps.manager.dirty) {
        // The server snapshot already contains this task name. Creating the
        // missing task alone completed the repair, so it must not be cleaned up.
        createdTaskIds.clear()
        bindingPersisted = true
      }
    })
  }
  finally {
    if (!saveAttempted && createdTaskIds.size) {
      await deps.deleteTopologyPingTasks([...createdTaskIds])
      recordTopologyWrite({
        trigger: 'auto',
        action: `回滚本轮新建的探测任务 ${summarizeTaskNames(createdTaskNames)}`,
        outcome: 'ok',
        detail: '配置未能保存，已把刚建的任务删掉',
      })
    }
  }

  if (bindingPersisted && createdTaskNames.length) {
    recordTopologyWrite({
      trigger: 'auto',
      action: `创建探测任务 ${summarizeTaskNames(createdTaskNames)} 并写回拓扑绑定`,
      outcome: 'ok',
    })
  }

  if (bindingPersisted) {
    const retiredIds = listOwnedRetiredTaskIds(
      appliedRetiredTasks,
      sessionCreatedTaskIds,
      liveTopologyTaskNames(deps.manager.routes),
    )
    if (retiredIds.length) {
      const removed = await deps.deleteTopologyPingTasks(retiredIds)
      if (removed) {
        for (const id of retiredIds)
          sessionCreatedTaskIds.delete(id)
      }
      recordTopologyWrite({
        trigger: 'auto',
        action: `清理已换掉的旧探测任务 ${summarizeTaskNames(appliedRetiredTasks.filter(task => retiredIds.includes(task.id)).map(task => task.name))}`,
        outcome: removed ? 'ok' : 'failed',
        detail: removed ? undefined : '删除请求未成功，新任务不受影响，下一轮会重试',
      })
    }
  }

  return outcome
}
