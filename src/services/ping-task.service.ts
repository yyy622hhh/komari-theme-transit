import type { AdminPingTask, TopologyHopProbe, TopologyPingEndpoint } from '@/services/ping-task.model'
import type { PingTaskMutation } from '@/utils/rpc'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { CACHE_CONFIG } from '@/constants/cache'
import { isAuthenticated, requirePermission, setAuthSessionFromLogin, subscribeAuthSession } from '@/services/auth.service'
import { SharedCache } from '@/services/cache.service'
import { invalidatePublicPingTasksCache } from '@/services/metrics.service'
import {
  buildTopologyEntryProbeDraft,
  DEFAULT_TOPOLOGY_HOP_PROBE,
  describeTopologyHopProbe,
  draftTopologyPingTask,
  findPresetEntryTaskTemplate,
  findTopologyEntryProbeTask,
  findTopologyPingTask,
  isPingTaskAssignedToSource,
  isSameTopologyHopProbe,
  normalizeTopologyHopProbe,
  supportedPingTaskNames,
  topologyHopProbeFromTask,
  topologyPingTargets,
} from '@/services/ping-task.model'
import { requestManager } from '@/services/request.service'
import { getSharedRpc, isRpcPermissionError, RpcError } from '@/utils/rpc'
import { logAppWarning } from '@/utils/safeError'

export * from '@/services/ping-task.model'

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted)
    return
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  throw error
}

async function withCrossTabPingLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    return task()
  return navigator.locks.request(`transit:topology-ping:${key}`, task)
}

function handlePingPermissionError(error: unknown): never {
  if (isRpcPermissionError(error)) {
    setAuthSessionFromLogin(false)
    throw new Error('登录状态已过期，请重新登录后管理 Ping 任务。')
  }
  throw error
}

function isMissingPingMethodError(error: unknown): boolean {
  return error instanceof RpcError && (
    error.code === -32601
    || error.code === 404
    || error.code === 405
  )
}

async function assertPingTaskPermission(force = true): Promise<void> {
  const permission = await requirePermission('advancedTools', { force })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后管理 Ping 任务。')
}

async function fetchAdminPingTasks(signal?: AbortSignal, requestKey = 'admin:ping:list'): Promise<AdminPingTask[]> {
  try {
    return await requestManager.run(requestKey, async (requestSignal) => {
      const tasks = await getSharedRpc().getAllPingTasks(requestSignal)
      return tasks.map(task => ({
        ...task,
        clients: Array.isArray(task.clients) ? task.clients : [],
        type: task.type ?? 'icmp',
        target: task.target ?? '',
      })) as AdminPingTask[]
    }, { retryAttempts: 0, signal })
  }
  catch (error) {
    handlePingPermissionError(error)
  }
}

const ADMIN_PING_TASKS_CACHE_KEY = 'admin:ping:list'
const adminPingTasksCache = new SharedCache<AdminPingTask[]>({
  maxSize: CACHE_CONFIG.adminPingTasks.maxSize,
  ttl: CACHE_CONFIG.adminPingTasks.ttl,
})
let adminPingTasksCacheGeneration = 0

subscribeAuthSession(() => {
  invalidateAdminPingTasksCache()
})

/** 让下次 {@link loadAdminPingTasks} 强制重新拉取——创建或删除任务后调用。 */
export function invalidateAdminPingTasksCache(): void {
  adminPingTasksCacheGeneration += 1
  adminPingTasksCache.clear()
}

/**
 * 读路径用的任务列表，带短 TTL 缓存。
 *
 * 后台自愈每轮都会对多条线路各查一次这台线路机的任务列表；不缓存的话，权限
 * 强制重新校验（`force: true`）和 `admin:getAllPingTasks` 都会跟着线路数线
 * 性增长。命中缓存时跳过任务 RPC，只做认证 TTL 内的本地会话检查。写路径
 * （`ensureTopologyPingTask` 创建后回查确认）必须看到最新列表，走的是不缓存
 * 且使用独立请求键的 {@link fetchAdminPingTasks}。
 *
 * `options.fresh` 供需要跨标签页可见性的调用方使用：拿到保存锁之后重新规划
 * 一次（防止另一个标签页在拿锁前改过这条线路）就必须绕过缓存，否则两次规划
 * 读到的是同一份快照，锁内重新检查形同虚设。
 */
export async function loadAdminPingTasks(options: { fresh?: boolean, requestKey?: string } = {}): Promise<AdminPingTask[]> {
  if (!options.fresh) {
    const cached = adminPingTasksCache.get(ADMIN_PING_TASKS_CACHE_KEY)
    if (cached) {
      const generation = adminPingTasksCacheGeneration
      await assertPingTaskPermission(false)
      if (
        generation === adminPingTasksCacheGeneration
        && adminPingTasksCache.get(ADMIN_PING_TASKS_CACHE_KEY) === cached
      ) {
        return cached
      }
    }
  }
  await assertPingTaskPermission()
  const generation = ++adminPingTasksCacheGeneration
  const tasks = await fetchAdminPingTasks(
    undefined,
    options.requestKey ?? (options.fresh ? `admin:ping:list:fresh:${generation}` : ADMIN_PING_TASKS_CACHE_KEY),
  )
  if (generation === adminPingTasksCacheGeneration && isAuthenticated())
    adminPingTasksCache.set(ADMIN_PING_TASKS_CACHE_KEY, tasks)
  return tasks
}

export async function loadAdminPingTaskNamesForNode(
  nodeUuid: string,
  options: { fresh?: boolean, requestKey?: string } = {},
): Promise<string[]> {
  if (!nodeUuid.trim())
    return []
  return supportedPingTaskNames(await loadAdminPingTasks(options), nodeUuid)
}

export async function deleteTopologyPingTasks(taskIds: readonly number[], signal?: AbortSignal): Promise<boolean> {
  const ids = [...new Set(taskIds.filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length)
    return false
  try {
    await requestManager.run(
      `admin:ping:delete:${ids.join(',')}`,
      requestSignal => getSharedRpc().deletePingTasks(ids, requestSignal),
      { retryAttempts: 0, signal },
    )
    invalidatePublicPingTasksCache()
    invalidateAdminPingTasksCache()
    return true
  }
  catch {
    return false
  }
}

async function createTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  tasks: readonly AdminPingTask[],
  probe: TopologyHopProbe,
): Promise<void> {
  const draft = draftTopologyPingTask(source, target, probe, tasks)
  const body = { ...draft, default_on: draft.default_on ?? false }
  await requestManager.run(
    `admin:ping:add:${source.uuid}:${target.uuid}:${describeTopologyHopProbe(probe)}`,
    requestSignal => getSharedRpc().addPingTask(body, requestSignal),
    { retryAttempts: 0 },
  )
  invalidatePublicPingTasksCache()
  invalidateAdminPingTasksCache()
}

export async function planTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  probe: TopologyHopProbe = DEFAULT_TOPOLOGY_HOP_PROBE,
): Promise<{ task: AdminPingTask, needsCreation: boolean }> {
  if (!source.uuid.trim() || !target.uuid.trim())
    throw new Error('线路机或落地机已失效，请重新选择。')
  if (!topologyPingTargets(target).length)
    throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
  const tasks = await loadAdminPingTasks()
  const existing = findTopologyPingTask(tasks, source.uuid, target, probe)
  if (existing)
    return { task: existing, needsCreation: false }
  return { task: draftTopologyPingTask(source, target, probe, tasks), needsCreation: true }
}

export async function ensureTopologyPingTask(
  source: TopologyPingEndpoint,
  target: TopologyPingEndpoint,
  options: { probe?: TopologyHopProbe, signal?: AbortSignal } = {},
): Promise<{ task: AdminPingTask, created: boolean }> {
  const { signal } = options
  const probe = normalizeTopologyHopProbe(options.probe)
  throwIfAborted(signal)
  const requestKey = `${source.uuid}:${target.uuid}:${topologyPingTargets(target).join(',')}:${describeTopologyHopProbe(probe)}`
  return withCrossTabPingLock(requestKey, async () => {
    if (!source.uuid.trim() || !target.uuid.trim())
      throw new Error('线路机或落地机已失效，请重新选择。')
    if (!topologyPingTargets(target).length)
      throw new Error(`落地机“${target.name}”没有可用于 Ping 的 IPv4 或 IPv6 地址。`)
    throwIfAborted(signal)
    await assertPingTaskPermission()
    throwIfAborted(signal)
    let tasks = await fetchAdminPingTasks(signal, `admin:ping:list:ensure:${requestKey}:before`)
    const existing = findTopologyPingTask(tasks, source.uuid, target, probe)
    if (existing)
      return { task: existing, created: false }

    throwIfAborted(signal)
    try {
      // Once the mutation starts it must run through the confirming read. An
      // abort after the server commits but before the response arrives cannot
      // prove whether the task exists; returning its ID lets the caller either
      // bind it or compensate by deleting it.
      await createTopologyPingTask(source, target, tasks, probe)
    }
    catch (error) {
      if (isRpcPermissionError(error))
        handlePingPermissionError(error)
      // The response may fail after the server commits. Reconcile without the
      // caller's abort signal before deciding whether this was a real failure;
      // a second tab may also have created the same task concurrently.
      tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:ensure:${requestKey}:retry`)
      const concurrent = findTopologyPingTask(tasks, source.uuid, target, probe)
      if (concurrent)
        return { task: concurrent, created: false }
      throw error
    }

    tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:ensure:${requestKey}:after`)
    const created = findTopologyPingTask(tasks, source.uuid, target, probe)
    if (!created)
      throw new Error('Ping 任务已提交，但服务器未返回对应任务，请稍后重试。')
    return { task: created, created: true }
  })
}

function pingTaskMutationFromAdmin(task: AdminPingTask, clients: string[]): PingTaskMutation {
  return {
    id: task.id,
    name: task.name,
    clients,
    default_on: Boolean(task.default_on),
    type: task.type,
    target: task.target,
    interval: task.interval || 30,
  }
}

function entryTaskMatchesName(task: AdminPingTask, sourceUuid: string, taskName: string): boolean {
  return isPingTaskAssignedToSource(task, sourceUuid) && task.name.trim() === taskName.trim()
}

function entryTaskIds(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  taskName: string,
): Set<number> {
  return new Set(tasks
    .filter(task => entryTaskMatchesName(task, sourceUuid, taskName) && Number.isInteger(task.id))
    .map(task => task.id!))
}

function findNewEntryTask(
  tasks: readonly AdminPingTask[],
  sourceUuid: string,
  taskName: string,
  hopProbe: TopologyHopProbe,
  previousIds: ReadonlySet<number>,
): AdminPingTask | undefined {
  return tasks
    .filter(task => entryTaskMatchesName(task, sourceUuid, taskName))
    .filter((task) => {
      const taskProbe = topologyHopProbeFromTask(task)
      return taskProbe !== null && isSameTopologyHopProbe(taskProbe, hopProbe)
    })
    .filter(task => Number.isInteger(task.id) && !previousIds.has(task.id!))
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0]
}

/**
 * 复用站内已有的同名入口任务：只把线路机加进 clients，不新建。
 *
 * 复用来的任务不是主题建的，因此不记所有权，阶梯换挡时也不会被清理。探测方式
 * 必须和本次要用的一致，否则 ICMP 的老任务会被当成 TCP 那一档用。
 */
async function adoptExistingEntryTask(
  tasks: readonly AdminPingTask[],
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  hopProbe: TopologyHopProbe,
  taskName: string,
  requestKey: string,
): Promise<AdminPingTask | null> {
  const template = findPresetEntryTaskTemplate(tasks, probe.key)
  if (!template || !Number.isInteger(template.id) || template.name.trim() !== taskName)
    return null
  const templateProbe = topologyHopProbeFromTask(template)
  if (!templateProbe || !isSameTopologyHopProbe(templateProbe, hopProbe))
    return null
  if (isPingTaskAssignedToSource(template, source.uuid))
    return template

  const clients = [...new Set([...(template.clients ?? []), source.uuid])]
  try {
    await requestManager.run(
      `admin:ping:edit:entry:${requestKey}`,
      requestSignal => getSharedRpc().editPingTasks([pingTaskMutationFromAdmin(template, clients)], requestSignal),
      { retryAttempts: 0 },
    )
    invalidatePublicPingTasksCache()
    invalidateAdminPingTasksCache()
  }
  catch (error) {
    if (isRpcPermissionError(error))
      handlePingPermissionError(error)
    // 站点没有 admin:editPingTask 时退回新建；其它失败也一样，新建总能兜住。
    if (!isMissingPingMethodError(error))
      logAppWarning('Failed to adopt an existing entry ping task; creating a new one', error)
    return null
  }

  const refreshed = await fetchAdminPingTasks(undefined, `admin:ping:list:entry:${requestKey}:after-edit`)
  return refreshed.find(task => task.id === template.id && isPingTaskAssignedToSource(task, source.uuid)) ?? null
}

/**
 * 按名字复用入口任务；没有匹配时才新建。换挡必须走 `createTopologyEntryProbeTask`，
 * 否则会把同名的判死任务当成已存在。
 */
export async function ensureTopologyEntryProbeTask(
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  options: { hopProbe?: TopologyHopProbe, signal?: AbortSignal, taskName?: string } = {},
): Promise<{ task: AdminPingTask, created: boolean }> {
  const { signal } = options
  const hopProbe = normalizeTopologyHopProbe(options.hopProbe)
  throwIfAborted(signal)
  const requestKey = `entry:${source.uuid}:${probe.key}`
  return withCrossTabPingLock(requestKey, async () => {
    if (!source.uuid.trim())
      throw new Error('线路机已失效，请重新选择。')
    throwIfAborted(signal)
    await assertPingTaskPermission()
    throwIfAborted(signal)
    let tasks = await fetchAdminPingTasks(signal, `admin:ping:list:entry:${requestKey}:before`)
    const requestedName = options.taskName?.trim() ?? ''
    const existing = findTopologyEntryProbeTask(tasks, source.uuid, probe, hopProbe, requestedName)
    if (existing)
      return { task: existing, created: false }

    throwIfAborted(signal)
    const taskName = requestedName || probe.taskFilter

    // 站里已经有这个运营商的任务、只是没把这台线路机算进去时，把线路机加进
    // clients 而不是再建一个同名任务。Komari 的 default_on 只对之后新注册的
    // 节点生效，所以「站长早就建好了三网任务」是最常见的情况。
    const adopted = await adoptExistingEntryTask(tasks, source, probe, hopProbe, taskName, requestKey)
    if (adopted)
      return { task: adopted, created: false }

    const draft = buildTopologyEntryProbeDraft(source, probe, hopProbe, taskName)
    const body = { ...draft, default_on: draft.default_on ?? false }
    const previousIds = entryTaskIds(tasks, source.uuid, taskName)
    try {
      await requestManager.run(
        `admin:ping:add:entry:${requestKey}`,
        requestSignal => getSharedRpc().addPingTask(body, requestSignal),
        { retryAttempts: 0 },
      )
      invalidatePublicPingTasksCache()
      invalidateAdminPingTasksCache()
    }
    catch (error) {
      if (isRpcPermissionError(error))
        handlePingPermissionError(error)
      tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:entry:${requestKey}:retry`)
      const committed = findNewEntryTask(tasks, source.uuid, taskName, hopProbe, previousIds)
      if (committed)
        return { task: committed, created: true }
      throw error
    }

    tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:entry:${requestKey}:after`)
    const created = findNewEntryTask(tasks, source.uuid, taskName, hopProbe, previousIds)
    if (!created)
      throw new Error('Ping 任务已提交，但服务器未返回对应任务，请稍后重试。')
    return { task: created, created: true }
  })
}

/**
 * 入口换挡专用：不按同名复用，直接新建。与 `ensureTopologyEntryProbeTask` 共用同一把锁。
 */
export async function createTopologyEntryProbeTask(
  source: TopologyPingEndpoint,
  probe: TopologyProbeOption,
  hopProbe: TopologyHopProbe,
  options: { signal?: AbortSignal, taskName?: string } = {},
): Promise<AdminPingTask> {
  const { signal } = options
  const normalized = normalizeTopologyHopProbe(hopProbe)
  throwIfAborted(signal)
  const requestKey = `entry:${source.uuid}:${probe.key}`
  return withCrossTabPingLock(requestKey, async () => {
    if (!source.uuid.trim())
      throw new Error('线路机已失效，请重新选择。')
    throwIfAborted(signal)
    await assertPingTaskPermission()
    throwIfAborted(signal)
    const taskName = options.taskName?.trim() || probe.taskFilter
    let tasks = await fetchAdminPingTasks(signal, `admin:ping:list:entry:switch:${requestKey}:before`)
    const previousIds = entryTaskIds(tasks, source.uuid, taskName)
    const draft = buildTopologyEntryProbeDraft(source, probe, normalized, taskName)
    const body = { ...draft, default_on: draft.default_on ?? false }
    try {
      await requestManager.run(
        `admin:ping:add:entry:switch:${requestKey}:${describeTopologyHopProbe(normalized)}`,
        requestSignal => getSharedRpc().addPingTask(body, requestSignal),
        { retryAttempts: 0 },
      )
      invalidatePublicPingTasksCache()
      invalidateAdminPingTasksCache()
    }
    catch (error) {
      if (isRpcPermissionError(error))
        handlePingPermissionError(error)
      tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:entry:switch:${requestKey}:retry`)
      const committed = findNewEntryTask(tasks, source.uuid, taskName, normalized, previousIds)
      if (committed)
        return committed
      throw error
    }

    // The caller may abort after the server commits. Reconcile without that
    // signal and identify the new ID relative to the pre-mutation snapshot.
    tasks = await fetchAdminPingTasks(undefined, `admin:ping:list:entry:switch:${requestKey}:after`)
    const created = findNewEntryTask(tasks, source.uuid, taskName, normalized, previousIds)
    if (!created)
      throw new Error('Ping 任务已提交，但服务器未返回对应任务，请稍后重试。')
    return created
  })
}
