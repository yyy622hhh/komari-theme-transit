import type { ComputedRef, Ref } from 'vue'
import type { TopologyPendingEntryTask, TopologyPendingRouteTask, TopologyRetiredTaskCandidate } from '@/composables/useTopologyRoutePlanner'
import type { TopologyPingEndpoint } from '@/services/ping-task.service'
import type { NodeData } from '@/stores/nodes'
import type { MessageApi } from '@/utils/message'
import type { TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
import { ref } from 'vue'
import { createTopologyEntryProbeTask, deleteTopologyPingTasks, ensureTopologyEntryProbeTask, ensureTopologyPingTask, loadAdminPingTasks } from '@/services/ping-task.service'
import { listOwnedRetiredTaskIds, listOwnedUnboundTaskIds, liveTopologyTaskNames } from '@/services/topology-repair.service'
import { persistTopologyCreatedTaskIds } from '@/utils/topologyCreatedTasks'
import { getTopologyRouteProbeKey, resolveTopologyNode } from '@/utils/topologyHelper'
import { getTopologyProbe } from '@/utils/topologyPresets'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

interface TopologyPersistenceManager {
  routes: TopologyRouteConfig[]
  quickNodes: TopologyQuickNode[]
  preflightSave: () => Promise<void>
  save: (options?: { lockHeld?: boolean }) => Promise<'invalid' | 'saved' | 'changed'>
  withSaveLock: <T>(save: () => Promise<T>) => Promise<T>
}

export interface TopologyPersistOptions {
  keepOpen?: boolean
  successMessage?: string
  runId?: number
  ignoreBusy?: boolean
  quiet?: boolean
}

interface TopologyPersistenceDependencies {
  props: Readonly<{ nodes: NodeData[], open: boolean }>
  manager: TopologyPersistenceManager
  taskValidationPending: ComputedRef<boolean>
  persistBlockingErrors: ComputedRef<string[]>
  pendingRouteTasks: Ref<Record<number, TopologyPendingRouteTask>>
  pendingEntryTasks: Ref<Record<number, TopologyPendingEntryTask>>
  routeRetiredTasks: Ref<Record<number, TopologyRetiredTaskCandidate[]>>
  routeEntryRetiredTasks: Ref<Record<number, TopologyRetiredTaskCandidate[]>>
  routeTaskErrors: Ref<Record<number, string>>
  sessionCreatedTaskIds: Set<number>
  findEndpoint: (uuid: string) => TopologyPingEndpoint | undefined
  rememberTask: (sourceUuid: string, taskName: string) => void
  clearPendingRouteTask: (routeId: number) => void
  clearPendingEntryTask: (routeId: number) => void
  clearRouteTaskError: (routeId: number) => void
  hasPendingWork: () => boolean
  getDialogSession: () => number
  getQuickConfigurationRun: () => number
  onOpenChange: (open: boolean) => void
  refreshWriteLog: () => void
  message: MessageApi
  operations?: Partial<{
    ensureRouteTask: typeof ensureTopologyPingTask
    ensureEntryTask: typeof ensureTopologyEntryProbeTask
    createEntryTask: typeof createTopologyEntryProbeTask
    deleteTasks: typeof deleteTopologyPingTasks
    loadTasks: typeof loadAdminPingTasks
  }>
}

export function createTopologyPersistence(deps: TopologyPersistenceDependencies) {
  const {
    props,
    manager,
    taskValidationPending,
    persistBlockingErrors,
    pendingRouteTasks,
    pendingEntryTasks,
    routeRetiredTasks,
    routeEntryRetiredTasks,
    routeTaskErrors,
    sessionCreatedTaskIds,
    findEndpoint,
    rememberTask,
    clearPendingRouteTask,
    clearPendingEntryTask,
    clearRouteTaskError,
    hasPendingWork,
    getDialogSession,
    getQuickConfigurationRun,
    onOpenChange,
    refreshWriteLog,
    message,
    operations,
  } = deps
  const ensureRouteTask = operations?.ensureRouteTask ?? ensureTopologyPingTask
  const ensureEntryTask = operations?.ensureEntryTask ?? ensureTopologyEntryProbeTask
  const createEntryTask = operations?.createEntryTask ?? createTopologyEntryProbeTask
  const deleteTasks = operations?.deleteTasks ?? deleteTopologyPingTasks
  const loadTasks = operations?.loadTasks ?? loadAdminPingTasks
  let persistTail: Promise<unknown> = Promise.resolve()
  let saveTaskController: AbortController | null = null
  const persisting = ref(false)

  /**
   * 清理本页面会话中由主题创建、随后被换掉的旧探测任务。
   *
   * 名称不是所有权证明：既有任务即使恰好使用 Transit 命名也不能删除。这里只接受
   * ensure 明确返回 created=true 后记录的 ID，并在配置保存成功后再次确认没有线路绑定。
   */
  async function retireReplacedTasks(): Promise<void> {
    const entries = Object.entries(routeRetiredTasks.value)
    routeRetiredTasks.value = {}
    const boundNames = liveTopologyTaskNames(manager.routes)
    const ids = new Set(listOwnedRetiredTaskIds(
      entries.flatMap(([, tasks]) => tasks),
      sessionCreatedTaskIds,
      boundNames,
    ))

    // 入口段换挡（ICMP 判死切 TCP）留下的旧任务：名字还是同一个预设名、还在
    // `boundNames` 里（只是换了个 id），所以不能用「名字不再被引用」判断，只能
    // 靠 `planEntryProbeTask` 已经精确认出来的候选（见 `routeEntryRetiredTasks`）。
    const entryEntries = Object.entries(routeEntryRetiredTasks.value)
    routeEntryRetiredTasks.value = {}
    for (const task of entryEntries.flatMap(([, tasks]) => tasks)) {
      if (sessionCreatedTaskIds.has(task.id))
        ids.add(task.id)
    }

    try {
      const tasks = await loadTasks({ fresh: true })
      // 换预设（如「北京电信」→「北京联通」）留下的旧任务：名字已经不被任何
      // 线路引用，按所有权反查完整任务列表挑出来。
      for (const id of listOwnedUnboundTaskIds(sessionCreatedTaskIds, tasks, boundNames))
        ids.add(id)
      for (const id of [...sessionCreatedTaskIds]) {
        if (!tasks.some(task => task.id === id))
          sessionCreatedTaskIds.delete(id)
      }
    }
    catch {
    // 任务列表读失败时仍按规划阶段记下的候选清理。
    }
    if (ids.size) {
      const removed = await deleteTasks([...ids])
      if (removed) {
        for (const id of ids)
          sessionCreatedTaskIds.delete(id)
      }
      recordTopologyWrite({
        trigger: 'manual',
        action: `清理不再使用的探测任务（${ids.size} 个）`,
        outcome: removed ? 'ok' : 'failed',
        detail: removed ? undefined : '删除请求未成功，绑定不受影响',
      })
    }
    persistTopologyCreatedTaskIds(sessionCreatedTaskIds)
  }

  /**
   * 回滚本轮已创建、但绑定没能落盘的任务。
   *
   * 必须记进写入流水：不然流水里只剩「创建任务 X · 成功」，而 X 其实已经被删掉，
   * 事后看日志会得出与现实相反的结论——那正是这份流水存在要避免的事。
   */
  async function cleanupCreatedTasks(taskIds: ReadonlySet<number>, reason: string): Promise<void> {
    const ids = [...taskIds]
    if (!ids.length)
      return
    const removed = await deleteTasks(ids)
    if (removed) {
      for (const id of ids)
        sessionCreatedTaskIds.delete(id)
      persistTopologyCreatedTaskIds(sessionCreatedTaskIds)
    }
    recordTopologyWrite({
      trigger: 'manual',
      action: `回滚本轮新建的探测任务（${ids.length} 个）`,
      outcome: removed ? 'ok' : 'failed',
      detail: removed ? reason : `${reason}；删除请求未成功，任务仍归主题所有，下次保存会再尝试清理`,
    })
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  function enqueuePersist<T>(work: () => Promise<T>): Promise<T> {
    const run = persistTail.then(work, work)
    persistTail = run.then(() => undefined, () => undefined)
    return run
  }

  async function persistRoutes(options: {
    keepOpen?: boolean
    successMessage?: string
    runId?: number
    ignoreBusy?: boolean
    quiet?: boolean
  } = {}): Promise<'invalid' | 'saved' | 'changed' | 'cancelled'> {
    return enqueuePersist(async () => {
      if (!props.open)
        return 'cancelled'
      if (taskValidationPending.value && options.runId === undefined && !options.ignoreBusy) {
        if (!options.quiet)
          message?.warning('正在验证 Ping 任务，请稍后再保存。')
        return 'invalid'
      }
      if (persistBlockingErrors.value.length) {
        if (!options.quiet)
          message?.error('请先修正无效的线路配置。')
        return 'invalid'
      }
      if (!hasPendingWork()) {
        if (options.runId !== undefined && options.successMessage) {
          message?.success(options.successMessage)
          return 'saved'
        }
        return 'cancelled'
      }
      const session = getDialogSession()
      const runId = options.runId ?? getQuickConfigurationRun()
      const controller = new AbortController()
      const createdTaskIds = new Set<number>()
      let saveAttempted = false
      saveTaskController = controller
      persisting.value = true
      try {
        const persist = async (lockHeld = false) => {
          const completedRouteTasks: Array<{ routeId: number, pending: TopologyPendingRouteTask }> = []
          const completedEntryTasks: Array<{ routeId: number, pending: TopologyPendingEntryTask }> = []
          let routeTaskCreationFailed = false
          for (const route of manager.routes) {
            const pending = pendingRouteTasks.value[route.id]
            if (!pending)
              continue
            const source = findEndpoint(pending.sourceUuid)
            const target = findEndpoint(pending.targetUuid)
            if (!source || !target)
              throw new Error('待创建 Ping 任务的节点已变化，请重新选择线路。')
            const routeSource = resolveTopologyNode(props.nodes, route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
            const routeTarget = resolveTopologyNode(props.nodes, route.nodes[2]?.name ?? '', route.nodes[2]?.uuid ?? '')
            const plannedMetric = route.metrics[1]
            if (routeSource?.uuid !== pending.sourceUuid
              || routeTarget?.uuid !== pending.targetUuid
              || !plannedMetric?.live
              || plannedMetric.nodeName !== source.name
              || plannedMetric.taskFilter !== pending.taskName) {
              throw new Error('待创建 Ping 任务对应的线路段已变化，请重新选择。')
            }
            try {
              const ensured = await ensureRouteTask(source, target, { probe: pending.probe, signal: controller.signal })
              if (ensured.created && Number.isInteger(ensured.task.id)) {
                sessionCreatedTaskIds.add(ensured.task.id!)
                persistTopologyCreatedTaskIds()
                createdTaskIds.add(ensured.task.id!)
                recordTopologyWrite({ trigger: 'manual', action: `创建第 2 段探测任务 ${ensured.task.name}`, outcome: 'ok' })
              }
              if (runId !== getQuickConfigurationRun() || session !== getDialogSession() || !props.open) {
                await cleanupCreatedTasks(createdTaskIds, '保存过程中线路或对话框已变化')
                return 'cancelled' as const
              }
              const metric = route.metrics[1]!
              metric.nodeName = source.name
              metric.taskFilter = ensured.task.name
              metric.live = true
              rememberTask(source.uuid, ensured.task.name)
              completedRouteTasks.push({ routeId: route.id, pending })
              clearRouteTaskError(route.id)
            }
            catch (error) {
              if (controller.signal.aborted)
                throw error
              routeTaskErrors.value = {
                ...routeTaskErrors.value,
                [route.id]: error instanceof Error ? error.message : '无法创建探测任务。',
              }
              routeTaskCreationFailed = true
              continue
            }
          }
          if (routeTaskCreationFailed) {
            await cleanupCreatedTasks(createdTaskIds, '同一批中有线路创建失败')
            message?.error('部分探测任务创建失败，已回滚本轮新建任务，未保存未完成的绑定。')
            return 'invalid' as const
          }
          for (const route of manager.routes) {
            const pendingEntry = pendingEntryTasks.value[route.id]
            if (!pendingEntry)
              continue
            const source = findEndpoint(pendingEntry.sourceUuid)
            if (!source)
              throw new Error('待创建 Ping 任务的节点已变化，请重新选择线路。')
            const routeSource = resolveTopologyNode(props.nodes, route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
            const firstMetric = route.metrics[0]
            if (routeSource?.uuid !== pendingEntry.sourceUuid
              || getTopologyRouteProbeKey(route) !== pendingEntry.probeKey
              || !firstMetric?.live
              || firstMetric.nodeName !== source.name
              || firstMetric.taskFilter !== pendingEntry.taskName) {
              throw new Error('待创建 Ping 任务对应的线路段已变化，请重新选择。')
            }
            const ensured = pendingEntry.forceCreate
              ? { task: await createEntryTask(source, getTopologyProbe(pendingEntry.probeKey), pendingEntry.probe, { signal: controller.signal, taskName: pendingEntry.taskName }), created: true }
              : await ensureEntryTask(source, getTopologyProbe(pendingEntry.probeKey), { hopProbe: pendingEntry.probe, signal: controller.signal, taskName: pendingEntry.taskName })
            if (ensured.created && Number.isInteger(ensured.task.id)) {
              sessionCreatedTaskIds.add(ensured.task.id!)
              persistTopologyCreatedTaskIds()
              createdTaskIds.add(ensured.task.id!)
              recordTopologyWrite({ trigger: 'manual', action: `创建入口探测任务 ${ensured.task.name}`, outcome: 'ok' })
            }
            if (runId !== getQuickConfigurationRun() || session !== getDialogSession() || !props.open) {
              await cleanupCreatedTasks(createdTaskIds, '保存过程中线路或对话框已变化')
              return 'cancelled' as const
            }
            const metric = route.metrics[0]!
            metric.nodeName = source.name
            metric.taskFilter = ensured.task.name
            metric.live = true
            rememberTask(source.uuid, ensured.task.name)
            completedEntryTasks.push({ routeId: route.id, pending: pendingEntry })
          }
          if (runId !== getQuickConfigurationRun() || session !== getDialogSession() || !props.open) {
            await cleanupCreatedTasks(createdTaskIds, '保存过程中线路或对话框已变化')
            return 'cancelled' as const
          }
          if (createdTaskIds.size) {
            await manager.preflightSave()
            if (runId !== getQuickConfigurationRun() || session !== getDialogSession() || !props.open) {
              await cleanupCreatedTasks(createdTaskIds, '保存过程中线路或对话框已变化')
              return 'cancelled' as const
            }
          }
          saveAttempted = true
          const saveResult = await manager.save({ lockHeld })
          if (saveResult === 'invalid') {
            saveAttempted = false
            await cleanupCreatedTasks(createdTaskIds, '配置校验未通过，未保存')
            return saveResult
          }
          // 保存期间用户可能已经为同一路线生成了新的待办；只清除本次实际提交的
          // 那个对象，不能把较新的规划结果一并删掉。
          for (const completed of completedRouteTasks) {
            if (pendingRouteTasks.value[completed.routeId] === completed.pending)
              clearPendingRouteTask(completed.routeId)
          }
          for (const completed of completedEntryTasks) {
            if (pendingEntryTasks.value[completed.routeId] === completed.pending)
              clearPendingEntryTask(completed.routeId)
          }
          createdTaskIds.clear()
          return saveResult
        }
        const hasPendingTasks = manager.routes.some(route => Boolean(pendingRouteTasks.value[route.id]) || Boolean(pendingEntryTasks.value[route.id]))
        const result = hasPendingTasks
          ? await manager.withSaveLock(async () => {
              await manager.preflightSave()
              return persist(true)
            })
          : await persist()
        if (result === 'cancelled' || session !== getDialogSession() || !props.open)
          return 'cancelled'
        if (result === 'saved') {
          await retireReplacedTasks()
          refreshWriteLog()
          message?.success(options.successMessage ?? '拓扑配置已保存。')
          if (!options.keepOpen)
            onOpenChange(false)
        }
        else if (result === 'changed') {
          message?.warning('提交时的配置已保存，当前修改尚未保存。')
        }
        return result
      }
      catch (error) {
        if (createdTaskIds.size && !saveAttempted) {
          await cleanupCreatedTasks(createdTaskIds, '保存过程中出错，绑定未落盘')
        }
        else if (createdTaskIds.size) {
          try {
            await manager.preflightSave()
            await cleanupCreatedTasks(createdTaskIds, '保存过程中出错，服务端快照确认绑定未落盘')
          }
          catch {
          // Persistence is ambiguous after a write starts; keep tasks that may
          // already be referenced by the server-side topology snapshot.
          }
        }
        if (isAbortError(error) || session !== getDialogSession() || !props.open)
          return 'cancelled'
        message?.error(error instanceof Error ? error.message : '拓扑保存失败。')
        return 'invalid'
      }
      finally {
        if (saveTaskController === controller)
          saveTaskController = null
        persisting.value = false
      }
    })
  }

  function abort(): void {
    saveTaskController?.abort()
    saveTaskController = null
  }

  async function waitForIdle(): Promise<void> {
    await persistTail
  }

  return { abort, persisting, persistRoutes, waitForIdle }
}
