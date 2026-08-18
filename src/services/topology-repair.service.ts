import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { HopTaskPlan } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { findUniqueTopologyNode } from '@/utils/topologyHelper'

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
  signal?: AbortSignal
}

export interface TopologyRepairAvailability {
  /** 组件已卸载，effect scope 已停止。 */
  disposed: boolean
  /** 拓扑管理对话框正打开——操作者在手动编辑时，后台自愈让路。 */
  managerOpen: boolean
  /** 对应 appStore.privateFeaturesAllowed：只有已登录管理员才能触发写操作。 */
  privateFeaturesAllowed: boolean
  /** appStore.topologyRoute：还没配置任何线路时没什么可修的。 */
  topologyRoute: string
}

/** 是否可以跑一轮自愈。抽成纯函数，四个分支各自独立可测，不需要 Pinia。 */
export function canRunTopologyProbeRepair(state: TopologyRepairAvailability): boolean {
  return !state.disposed
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
    const source = findUniqueTopologyNode(deps.nodes(), route.nodes[1]?.name ?? '')
    const landing = findUniqueTopologyNode(deps.nodes(), route.nodes[2]?.name ?? '')
    const metric = route.metrics[1]
    if (!source || !landing || !metric?.live)
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
    }
  }

  const repairs = (await Promise.all(deps.manager.routes.map(route => planRouteRepair(route).catch(() => null))))
    .filter((repair): repair is PlannedProbeRepair => repair !== null)
  if (!repairs.length || !canContinue())
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
        metric.nodeName = latestRepair.source.name
        metric.taskFilter = taskName
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
