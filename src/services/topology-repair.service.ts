import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { EntryProbePlan, HopTaskPlan } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyProbeOption, TopologyRouteConfig } from '@/utils/topologyHelper'
import { getTopologyProbe, getTopologyRouteProbeKey, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'
import { resolveTopologyNodeIdentity } from '@/utils/topologyNodeIdentity'

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
  planEntryProbeTask: (
    source: TopologyPingEndpoint,
    probe: TopologyProbeOption,
    options?: { fresh?: boolean },
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
  /** 清理旧任务时，判断这个任务 ID 是不是本次（浏览器 tab 生命周期内的）自愈进程自己建的。 */
  isEntryTaskSessionOwned: (taskId: number) => boolean
  rememberEntryTaskCreated: (taskId: number) => void
  signal?: AbortSignal
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
}

/** 是否可以跑一轮自愈。抽成纯函数，每个分支各自独立可测，不需要 Pinia。 */
export function canRunTopologyProbeRepair(state: TopologyRepairAvailability): boolean {
  return !state.disposed
    && state.autoRepairEnabled
    && !state.managerOpen
    && state.privateFeaturesAllowed
    && Boolean(state.topologyRoute.trim())
}

export type TopologyRepairOutcome = 'skipped' | 'no-op' | 'repaired'

interface PlannedProbeRepair {
  route: TopologyRouteConfig
  source: NodeData
  landing: NodeData
  probe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
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

  async function planRouteRepair(route: TopologyRouteConfig, options: { fresh?: boolean } = {}): Promise<PlannedProbeRepair | null> {
    // 按名称找不到时退回本地「名称→uuid」缓存反查——线路机或落地机被在 Komari
    // 里改过名字，不该让这条线路永远卡在「探测节点未找到」，需要操作者手动
    // 重新选一遍。
    const source = resolveTopologyNodeIdentity(deps.nodes(), route.nodes[1]?.name ?? '')
    const landing = resolveTopologyNodeIdentity(deps.nodes(), route.nodes[2]?.name ?? '')
    const metric = route.metrics[1]
    if (!source || !landing || !metric?.live)
      return null

    const planned = await deps.planWorkingHopTask(source, landing, metric.taskFilter, options)
    const renamed = route.nodes[1]?.name.trim() !== source.name.trim()
      || route.nodes[2]?.name.trim() !== landing.name.trim()
    const bindingChanged = metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== planned.task.name.trim()
    if (!planned.needsCreation && !bindingChanged && !renamed)
      return null

    return {
      route,
      source,
      landing,
      probe: planned.probe,
      taskName: planned.task.name,
      needsCreation: planned.needsCreation,
    }
  }

  /** 入口段：绑定规划出的真实任务名，换挡先建后清。 */
  async function planEntryRepair(route: TopologyRouteConfig, options: { fresh?: boolean } = {}): Promise<PlannedEntryRepair | null> {
    const source = resolveTopologyNodeIdentity(deps.nodes(), route.nodes[1]?.name ?? '')
    if (!source)
      return null
    const probeKey = getTopologyRouteProbeKey(route)
    if (!probeKey || !shouldAutoApplyTopologyProbe(route))
      return null
    const probe = getTopologyProbe(probeKey)
    const metric = route.metrics[0]

    const plan = await deps.planEntryProbeTask(source, probe, options)
    if (plan.exhausted)
      return null

    const taskName = plan.task.name.trim() || probe.taskFilter
    const renamed = route.nodes[1]?.name.trim() !== source.name.trim()
    const bindingChanged = !metric?.live
      || metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== taskName
    const hasCleanableRetirement = plan.retiredTasks
      .some(task => Number.isInteger(task.id) && deps.isEntryTaskSessionOwned(task.id!))
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
    Promise.all(deps.manager.routes.map(route => planRouteRepair(route).catch(() => null)))
      .then(list => list.filter((repair): repair is PlannedProbeRepair => repair !== null)),
    Promise.all(deps.manager.routes.map(route => planEntryRepair(route).catch(() => null)))
      .then(list => list.filter((repair): repair is PlannedEntryRepair => repair !== null)),
  ])
  if ((!repairs.length && !entryRepairs.length) || !canContinue())
    return 'no-op'

  let outcome: TopologyRepairOutcome = 'no-op'
  const createdTaskIds = new Set<number>()
  let saveAttempted = false
  try {
    await deps.manager.withSaveLock(async () => {
      if (!canContinue())
        return
      await deps.manager.preflightSave()
      if (!canContinue())
        return

      for (const repair of repairs) {
        if (!canContinue())
          return
        // 锁内重新规划一次：另一个标签页可能已经在拿到锁之前改了这条线路。必须
        // 绕过任务列表缓存，否则这一次读到的还是拿锁前的同一份快照，等于没查。
        const latestRepair = await planRouteRepair(repair.route, { fresh: true })
        if (!latestRepair)
          continue
        const metric = latestRepair.route.metrics[1]
        if (!metric?.live)
          continue
        let taskName = latestRepair.taskName
        if (latestRepair.needsCreation) {
          const ensured = await deps.ensureTopologyPingTask(latestRepair.source, latestRepair.landing, {
            probe: latestRepair.probe,
            signal: deps.signal,
          })
          taskName = ensured.task.name
          if (ensured.created && Number.isInteger(ensured.task.id))
            createdTaskIds.add(ensured.task.id!)
        }
        if (!canContinue())
          return
        // 节点改名后把线路本身也校正到新名称，收敛回按名称匹配的快路径；否则
        // 探测任务修好了，图上和下次打开管理器时看到的仍然是改名前的旧名字。
        if (latestRepair.route.nodes[1])
          latestRepair.route.nodes[1].name = latestRepair.source.name
        if (latestRepair.route.nodes[2])
          latestRepair.route.nodes[2].name = latestRepair.landing.name
        metric.nodeName = latestRepair.source.name
        metric.taskFilter = taskName
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
            deps.rememberEntryTaskCreated(ensured.task.id!)
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
          .filter(task => Number.isInteger(task.id) && deps.isEntryTaskSessionOwned(task.id!))
          .map(task => task.id!)
        if (retirableIds.length)
          await deps.deleteTopologyPingTasks(retirableIds)
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
      }
    })
  }
  finally {
    if (!saveAttempted && createdTaskIds.size)
      await deps.deleteTopologyPingTasks([...createdTaskIds])
  }

  return outcome
}
