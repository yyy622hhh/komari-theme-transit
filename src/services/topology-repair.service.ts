import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { EntryProbePlan, HopTaskPlan } from '@/services/topology-probe.service'
import type { TopologyRetiredTask } from '@/services/topology-repair.helpers'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { restrictTopologyPingEndpoint } from '@/services/ping-task.service'
import { isStaleManagedThemeSettingsError } from '@/services/theme-settings.service'
import {
  listLiveEntryTaskIds,
  listOwnedRetiredTaskIds,
  liveTopologyTaskNames,
} from '@/services/topology-repair.helpers'
import { isTopologySaveCommittedError } from '@/services/topology.service'
import { getTopologyRouteEntryProbe, resolveTopologyNode, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'
import { getTopologyMetricProbeMode } from '@/utils/topologyModel'
import { rememberCreatedTopologyTask } from '@/utils/topologyTaskSnapshot'
import { recordTopologyWrite, summarizeTaskNames } from '@/utils/topologyWriteLog'

export type { TopologyRepairAvailability, TopologyRetiredTask } from '@/services/topology-repair.helpers'
export {
  canRunTopologyProbeRepair,
  listLiveEntryTaskIds,
  listOwnedRetiredTaskIds,
  listOwnedUnboundTaskIds,
  liveTopologyTaskNames,
} from '@/services/topology-repair.helpers'

/** 自愈流程使用的 `useTopologyManager()` 最小切面。 */
export interface TopologyRepairManagerLike {
  readonly routes: TopologyRouteConfig[]
  readonly validationErrors: readonly string[]
  readonly dirty: boolean
  reset: () => void
  withSaveLock: <T>(save: () => Promise<T>) => Promise<T>
  preflightSave: () => Promise<void>
  save: (options?: { lockHeld?: boolean, signal?: AbortSignal }) => Promise<'invalid' | 'saved' | 'changed'>
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
    options?: { fresh?: boolean, icmpOnly?: boolean },
  ) => Promise<HopTaskPlan>
  ensureTopologyPingTask: (
    source: TopologyPingEndpoint,
    landing: TopologyPingEndpoint,
    options: { probe: TopologyHopProbe, signal?: AbortSignal },
  ) => Promise<{ task: AdminPingTask, created: boolean }>
  deleteTopologyPingTasks: (taskIds: readonly number[]) => Promise<boolean>
  /** Created IDs are only candidates; the deletion boundary also requires the creation snapshot. */
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
  /** 换挡专用：不按同名复用死任务；同探针已存在则 created=false。 */
  createTopologyEntryProbeTask: (
    source: TopologyPingEndpoint,
    probe: TopologyProbeOption,
    hopProbe: TopologyHopProbe,
    options?: { signal?: AbortSignal, taskName?: string },
  ) => Promise<{ task: AdminPingTask, created: boolean }>
  /**
   * 入口任务清理前用来按「线路机 + 当前绑定名」反查真实任务 id：入口任务换挡
   * 后经常沿用旧名字，不能靠名字判断是否还在用，只能落到 id 上。缺省时退回
   * 只按会话所有权清理，不做这层额外保护。
   */
  loadAdminPingTasks?: (options?: { fresh?: boolean }) => Promise<AdminPingTask[]>
  signal?: AbortSignal
}

function ownedRetiredTasks(tasks: ReadonlyArray<{ id?: number, name: string }>): TopologyRetiredTask[] {
  return tasks.flatMap(task => (Number.isInteger(task.id) ? [{ id: task.id!, name: task.name }] : []))
}

export type TopologyRepairOutcome = 'skipped' | 'no-op' | 'repaired' | 'cleanup-failed'

interface PlannedProbeRepair {
  route: TopologyRouteConfig
  segmentIndex: number
  source: NodeData
  landing: NodeData
  probe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
  targetHost: string
  retiredTasks: TopologyRetiredTask[]
}

interface PlannedEntryRepair {
  route: TopologyRouteConfig
  source: NodeData
  probe: TopologyProbeOption
  hopProbe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
  /** 换挡或自定义入口迁移时必须新建，不能按名字找到就复用。 */
  forceCreate: boolean
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
  const validationErrors = deps.manager.validationErrors
  const unlabeledValidation = validationErrors.some(error => !/^第 \d+ 条线路/.test(error))
  if (unlabeledValidation)
    return 'skipped'
  const blockedRouteIndexes = new Set(
    validationErrors.flatMap((error) => {
      const match = /^第 (\d+) 条线路/.exec(error)
      return match ? [Number(match[1]) - 1] : []
    }),
  )
  if (deps.manager.routes.length > 0 && blockedRouteIndexes.size === deps.manager.routes.length)
    return 'skipped'

  const sessionCreatedTaskIds = deps.sessionCreatedTaskIds ?? new Set<number>()

  async function planRouteRepair(route: TopologyRouteConfig, segmentIndex: number, options: { fresh?: boolean } = {}): Promise<PlannedProbeRepair | null> {
    if (blockedRouteIndexes.has(deps.manager.routes.indexOf(route)))
      return null
    // 配置里带着 uuid，节点在 Komari 里改过名也认得回来。
    const source = resolveTopologyNode(deps.nodes(), route.nodes[segmentIndex]?.name ?? '', route.nodes[segmentIndex]?.uuid ?? '')
    const landing = resolveTopologyNode(deps.nodes(), route.nodes[segmentIndex + 1]?.name ?? '', route.nodes[segmentIndex + 1]?.uuid ?? '')
    const metric = route.metrics[segmentIndex]
    if (!source || !landing || !metric || getTopologyMetricProbeMode(metric) === 'static')
      return null
    // 离线节点不产生样本，`assessHopTask` 无法区分"这种探测方式被封"和"落地机
    // 挂了"。不加这道闸，一次十分钟的宕机就会把整条探测阶梯走完，留下一串谁也
    // 不会清理的 Ping 任务，并把主题配置重写好几遍。
    if (source.online === false || landing.online === false)
      return null

    const planned = await deps.planWorkingHopTask(source, landing, metric.taskFilter, { ...options, icmpOnly: true })
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
      targetHost: planned.targetAddress,
      retiredTasks: ownedRetiredTasks(planned.retiredTasks),
    }
  }

  /** 入口段：绑定规划出的真实任务名，换挡先建后清。 */
  async function planEntryRepair(route: TopologyRouteConfig, options: { fresh?: boolean } = {}): Promise<PlannedEntryRepair | null> {
    if (blockedRouteIndexes.has(deps.manager.routes.indexOf(route)))
      return null
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
    if (!metric || getTopologyMetricProbeMode(metric) === 'static')
      return null

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
      forceCreate: plan.switchedFrom !== null || customEntry,
      retiredTasks: plan.retiredTasks,
    }
  }

  const planErrors: unknown[] = []
  const settlePlan = <T>(work: Promise<T | null>): Promise<T | null> => work.catch((error) => {
    planErrors.push(error)
    return null
  })
  const [repairs, entryRepairs] = await Promise.all([
    Promise.all(deps.manager.routes.flatMap(route => Array.from(
      { length: Math.max(0, route.nodes.filter(node => node.name.trim()).length - 2) },
      (_, index) => settlePlan(planRouteRepair(route, index + 1)),
    )))
      .then(list => list.filter((repair): repair is PlannedProbeRepair => repair !== null)),
    Promise.all(deps.manager.routes.map(route => settlePlan(planEntryRepair(route))))
      .then(list => list.filter((repair): repair is PlannedEntryRepair => repair !== null)),
  ])
  if (!repairs.length && !entryRepairs.length) {
    if (planErrors.length)
      throw planErrors[0]
    return 'no-op'
  }
  if (!canContinue())
    return 'no-op'

  let outcome: TopologyRepairOutcome = 'no-op'
  const createdTaskIds = new Set<number>()
  /** 用于流水记录：本轮实际建过哪些任务，按名字记，操作者在 Komari 里看到的就是名字。 */
  const createdTaskNames: string[] = []
  const recordCreatedTask = (ensured: { created: boolean, task: AdminPingTask }) => {
    if (!ensured.created || !Number.isInteger(ensured.task.id))
      return
    createdTaskIds.add(ensured.task.id!)
    createdTaskNames.push(ensured.task.name)
    sessionCreatedTaskIds.add(ensured.task.id!)
    rememberCreatedTopologyTask(ensured.task)
  }
  const appliedRetiredTasks: TopologyRetiredTask[] = []
  /**
   * 入口换挡前后任务名经常不变（ICMP → TCP 443 仍叫「北京电信」），不能走
   * `listOwnedRetiredTaskIds` 那种「名字已经没人绑」过滤，只能按会话所有权
   * 和 ID 清。同样必须等绑定落盘后再删，否则 save 失败会把新旧任务都弄丢。
   */
  const appliedEntryRetiredTasks: TopologyRetiredTask[] = []
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
        // GET 已把权威值写回 store；reset 后下一轮按新快照规划。
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
        if (!metric || getTopologyMetricProbeMode(metric) === 'static')
          continue
        let taskName = latestRepair.taskName
        if (latestRepair.needsCreation) {
          try {
            const landing = restrictTopologyPingEndpoint(latestRepair.landing, latestRepair.targetHost)
            const ensured = await deps.ensureTopologyPingTask(latestRepair.source, landing, {
              probe: latestRepair.probe,
              signal: deps.signal,
            })
            taskName = ensured.task.name
            recordCreatedTask(ensured)
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
        metric.live = true
        metric.probeMode = 'live'
        appliedRetiredTasks.push(...latestRepair.retiredTasks)
      }

      for (const repair of entryRepairs) {
        if (!canContinue())
          return
        // 同样在锁内重新规划一次，理由与第 2 段一致；单条失败也必须吞掉，
        // 否则会穿过 withSaveLock 把本轮已经建好的第 2 段任务一并回滚。
        const latestEntryRepair = await planEntryRepair(repair.route, { fresh: true }).catch(() => null)
        if (!latestEntryRepair)
          continue
        const metric = latestEntryRepair.route.metrics[0]
        if (!metric)
          continue
        let taskName = latestEntryRepair.taskName
        if (latestEntryRepair.needsCreation) {
          try {
            const ensured = latestEntryRepair.forceCreate
              ? await deps.createTopologyEntryProbeTask(latestEntryRepair.source, latestEntryRepair.probe, latestEntryRepair.hopProbe, { signal: deps.signal, taskName: latestEntryRepair.taskName })
              : await deps.ensureTopologyEntryProbeTask(latestEntryRepair.source, latestEntryRepair.probe, {
                  hopProbe: latestEntryRepair.hopProbe,
                  signal: deps.signal,
                  taskName: latestEntryRepair.taskName,
                })
            taskName = ensured.task.name
            recordCreatedTask(ensured)
          }
          catch {
            // 单条入口任务失败不能掀翻整轮：否则 finally 会把已经建好的其他线路任务删掉。
            if (!canContinue())
              return
            continue
          }
        }
        if (!canContinue())
          return
        if (latestEntryRepair.route.nodes[1])
          latestEntryRepair.route.nodes[1].name = latestEntryRepair.source.name
        metric.nodeName = latestEntryRepair.source.name
        metric.taskFilter = taskName
        metric.live = true
        metric.probeMode = 'live'
        appliedEntryRetiredTasks.push(...ownedRetiredTasks(latestEntryRepair.retiredTasks))
      }

      if (deps.manager.dirty && canContinue()) {
        // 建任务和写主题是两次 RPC；写之前再核一次 expected，失败才能安全回滚。
        await deps.manager.preflightSave()
        if (!canContinue())
          return
        saveAttempted = true
        try {
          const result = await deps.manager.save({ lockHeld: true, signal: deps.signal })
          if (result === 'saved' || result === 'changed') {
            outcome = 'repaired'
            bindingPersisted = true
          }
          else {
            saveAttempted = false
          }
        }
        catch (error) {
          if (isTopologySaveCommittedError(error)) {
            outcome = 'repaired'
            bindingPersisted = true
            createdTaskIds.clear()
            return
          }
          if (error instanceof Error && error.name === 'AbortError') {
            try {
              await deps.manager.preflightSave()
              saveAttempted = false
            }
            catch {
              bindingPersisted = true
              createdTaskIds.clear()
            }
            return
          }
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
        createdTaskIds.clear()
        bindingPersisted = true
      }
    })
  }
  finally {
    if (!saveAttempted && createdTaskIds.size) {
      const removed = await deps.deleteTopologyPingTasks([...createdTaskIds])
      recordTopologyWrite({
        trigger: 'auto',
        action: `回滚本轮新建的探测任务 ${summarizeTaskNames(createdTaskNames)}`,
        outcome: removed ? 'ok' : 'failed',
        detail: removed ? '配置未能保存，已把刚建的任务删掉' : '新任务清理未确认，可能已改变或缺少快照；请在后台核对',
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
      { boundTaskNames: liveTopologyTaskNames(deps.manager.routes) },
    )
    // 入口换挡后新任务经常沿用旧名字，不能按「名字是否仍被绑定」过滤，只能
    // 按线路机 + 当前绑定名反查真实 id：如果另一条共用同一台线路机的线路，
    // 保存后仍然绑着这个 id（哪怕名字和被清理的旧任务相同），也要保护它。
    // 任务列表读失败时不要删入口候选——id 级保护正是为这种情况准备的。
    // 没接 loadAdminPingTasks 时退回只按会话所有权 + 本轮新建 id 清理。
    const appliedEntryRetiredIds = new Set(appliedEntryRetiredTasks.map(task => task.id))
    let liveEntryTaskIds: Set<number> | null = new Set()
    if (appliedEntryRetiredTasks.length && deps.loadAdminPingTasks) {
      try {
        const tasks = await deps.loadAdminPingTasks({ fresh: true })
        liveEntryTaskIds = listLiveEntryTaskIds(
          deps.manager.routes,
          deps.nodes(),
          tasks,
          appliedEntryRetiredIds,
        )
      }
      catch {
        liveEntryTaskIds = null
      }
    }
    const entryRetiredIds = liveEntryTaskIds
      ? listOwnedRetiredTaskIds(
          appliedEntryRetiredTasks,
          sessionCreatedTaskIds,
          { excludeIds: new Set([...createdTaskIds, ...liveEntryTaskIds]) },
        )
      : []
    const cleanupIds = [...new Set([...retiredIds, ...entryRetiredIds])]
    if (cleanupIds.length) {
      const removed = await deps.deleteTopologyPingTasks(cleanupIds)
      if (removed) {
        for (const id of cleanupIds)
          sessionCreatedTaskIds.delete(id)
      }
      // 同一个旧任务可能被多条线路各自的 retiredTasks 记录到（比如它们共用
      // 同一个入口任务），按 id 去重后再拼流水文案，避免同一个任务名重复出现。
      const cleanupTaskNames = new Map<number, string>()
      for (const task of appliedRetiredTasks) {
        if (retiredIds.includes(task.id))
          cleanupTaskNames.set(task.id, task.name)
      }
      for (const task of appliedEntryRetiredTasks) {
        if (entryRetiredIds.includes(task.id))
          cleanupTaskNames.set(task.id, task.name)
      }
      const cleanupNames = [...cleanupTaskNames.values()]
      recordTopologyWrite({
        trigger: 'auto',
        action: `清理已换掉的旧探测任务 ${summarizeTaskNames(cleanupNames)}`,
        outcome: removed ? 'ok' : 'failed',
        detail: removed ? undefined : `任务 ${cleanupIds.join('、')} 清理未确认或快照已变化；新任务不受影响，请在后台核对`,
      })
      if (!removed)
        return 'cleanup-failed'
    }
  }

  return outcome
}
