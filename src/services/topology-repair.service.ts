import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.service'
import type { EntryProbePlan, HopTaskPlan } from '@/services/topology-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { entryTaskIds, restrictTopologyPingEndpoint } from '@/services/ping-task.service'
import { isStaleManagedThemeSettingsError } from '@/services/theme-settings.service'
import { isTopologySaveCommittedError } from '@/services/topology.service'
import { getTopologyRouteEntryProbe, resolveTopologyNode, shouldAutoApplyTopologyProbe } from '@/utils/topologyHelper'
import { getTopologyMetricProbeMode } from '@/utils/topologyModel'
import { recordTopologyWrite, summarizeTaskNames } from '@/utils/topologyWriteLog'

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

/**
 * 按「线路机 + 当前绑定名」反查仍需保留的入口任务 id。
 * 换挡前后故意同名，所以本轮退休 id 要从保护名单拿掉；若扣掉后一个匹配都不剩，把匹配到的 id 重新保护回去。
 */
export function listLiveEntryTaskIds(
  routes: readonly Pick<TopologyRouteConfig, 'nodes' | 'metrics'>[],
  nodes: readonly NodeData[],
  tasks: readonly AdminPingTask[],
  retiredIds: ReadonlySet<number> = new Set(),
): Set<number> {
  return new Set(routes.flatMap((route) => {
    const metric = route.metrics[0]
    const boundName = metric?.taskFilter.trim()
    if (!metric?.live || !boundName)
      return []
    const source = resolveTopologyNode(nodes, route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
    if (!source?.uuid)
      return []
    const matchingIds = [...entryTaskIds(tasks, source.uuid, boundName)]
    const remaining = matchingIds.filter(id => !retiredIds.has(id))
    return remaining.length ? remaining : matchingIds
  }))
}

/**
 * 只删本会话创建、且不在排除名单里的探测任务。跳数段按「名字是否仍被某条线路
 * 绑定」排除；入口段名字在换挡前后常常不变，只能按「是不是本轮刚建的」排除，
 * 见 `runTopologyProbeRepair` 里对 entryRetiredIds 的调用和旁边的注释。
 */
export function listOwnedRetiredTaskIds(
  retired: readonly TopologyRetiredTask[],
  sessionCreatedIds: ReadonlySet<number>,
  exclude: { boundTaskNames?: ReadonlySet<string>, excludeIds?: ReadonlySet<number> },
): number[] {
  return [...new Set(retired
    .filter(task => sessionCreatedIds.has(task.id)
      && !exclude.boundTaskNames?.has(task.name.trim())
      && !exclude.excludeIds?.has(task.id))
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
  /** appStore.topologyRoute：旧格式线路串。JSON-only 配置可能为空。 */
  topologyRoute: string
  /** JSON 拓扑里是否已经有线路。与 topologyRoute 任一有值即可自愈。 */
  topologyConfigured?: boolean
  /** 标签页在后台时没人看结果，也不需要发起写操作；恢复可见后由调用方立即重查一次。 */
  pageVisible: boolean
}

/** 是否可以跑一轮自愈。抽成纯函数，每个分支各自独立可测，不需要 Pinia。 */
export function canRunTopologyProbeRepair(state: TopologyRepairAvailability): boolean {
  return !state.disposed
    && state.autoRepairEnabled
    && !state.managerOpen
    && state.privateFeaturesAllowed
    && (Boolean(state.topologyRoute.trim()) || Boolean(state.topologyConfigured))
    && state.pageVisible
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
        detail: removed ? undefined : '删除请求未成功，新任务不受影响，下一轮会重试',
      })
      if (!removed)
        return 'cleanup-failed'
    }
  }

  return outcome
}
