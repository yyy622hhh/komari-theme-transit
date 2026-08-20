import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskPlan } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { isStaleManagedThemeSettingsError } from '@/services/theme-settings.service'
import { resolveTopologyNode } from '@/utils/topologyHelper'

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
  retiredTasks: TopologyRetiredTask[]
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
    const source = resolveTopologyNode(deps.nodes(), route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
    const landing = resolveTopologyNode(deps.nodes(), route.nodes[2]?.name ?? '', route.nodes[2]?.uuid ?? '')
    const metric = route.metrics[1]
    if (!source || !landing || !metric?.live)
      return null
    // 离线节点不产生样本，`assessHopTask` 无法区分"这种探测方式被封"和"落地机
    // 挂了"。不加这道闸，一次十分钟的宕机就会把整条探测阶梯走完，留下一串谁也
    // 不会清理的 Ping 任务，并把主题配置重写好几遍。
    if (source.online === false || landing.online === false)
      return null

    const planned = await deps.planWorkingHopTask(source, landing, metric.taskFilter, options)
    const bindingChanged = metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== planned.task.name.trim()
    if (!planned.needsCreation && !bindingChanged)
      return null

    return {
      route,
      source,
      landing,
      probe: planned.probe,
      taskName: planned.task.name,
      needsCreation: planned.needsCreation,
      retiredTasks: ownedRetiredTasks(planned.retiredTasks),
    }
  }

  const repairs = (await Promise.all(deps.manager.routes.map(route => planRouteRepair(route).catch(() => null))))
    .filter((repair): repair is PlannedProbeRepair => repair !== null)
  if (!repairs.length || !canContinue())
    return 'no-op'

  let outcome: TopologyRepairOutcome = 'no-op'
  const createdTaskIds = new Set<number>()
  const sessionCreatedTaskIds = deps.sessionCreatedTaskIds ?? new Set<number>()
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
        const latestRepair = await planRouteRepair(repair.route, { fresh: true }).catch(() => null)
        if (!latestRepair)
          continue
        const metric = latestRepair.route.metrics[1]
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
        metric.nodeName = latestRepair.source.name
        metric.taskFilter = taskName
        appliedRetiredTasks.push(...latestRepair.retiredTasks)
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
    if (!saveAttempted && createdTaskIds.size)
      await deps.deleteTopologyPingTasks([...createdTaskIds])
  }

  if (bindingPersisted) {
    const retiredIds = listOwnedRetiredTaskIds(
      appliedRetiredTasks,
      sessionCreatedTaskIds,
      liveTopologyTaskNames(deps.manager.routes),
    )
    if (retiredIds.length && await deps.deleteTopologyPingTasks(retiredIds)) {
      for (const id of retiredIds)
        sessionCreatedTaskIds.delete(id)
    }
  }

  return outcome
}
