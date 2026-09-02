import type { CarrierOperationRecord } from '@/services/carrier-probe-operation.service'
import type { CarrierNodeSamples, CarrierProbeCandidate, CarrierProbeMigrationResult, CarrierProbeOperations } from '@/services/carrier-probe.service'
import type { AdminPingTask } from '@/services/ping-task.model'
import { carrierTaskSnapshot, withCarrierOperationLock } from '@/services/carrier-probe-operation.service'
import { assessCarrierProbeCandidate, buildCarrierProbeCandidate } from '@/services/carrier-probe.service'
import { normalizeRawPingSamples, probeSampleFreshnessMs } from '@/utils/pingCurrentState'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

const WAIT_MS = 10_000
const TIMEOUT_MS = 240_000
const TTL_MS = 1_800_000
const copyTask = (task: AdminPingTask): AdminPingTask => ({ ...task, clients: [...task.clients] })
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'

export async function cleanupCarrierRecovery(record: CarrierOperationRecord, ops: CarrierProbeOperations): Promise<string> {
  return (ops.withLock ?? withCarrierOperationLock)(record.original.id!, true, async () => {
    if (record.uncertainCreation)
      throw new Error('创建响应未确认，无法识别全部资源，请在 Komari 后台按任务名称核对。')
    await assertOriginal(record.original, ops)
    const remaining: number[] = []
    for (const created of record.created) {
      if (created.id === record.original.id || (created.name !== record.original.name && !/^Transit-canary-[a-z-]+-\d{13}$/.test(created.name)))
        throw new Error('操作记录中的资源无法安全识别，请在 Komari 后台人工核对。')
      if (!await cleanup(created, ops))
        remaining.push(created.id!)
    }
    if (remaining.length)
      throw new Error(`资源 ${remaining.join('、')} 已改变或清理未确认；没有删除原任务。`)
    return '本次残留资源已清理，原任务保留。'
  })
}

async function authorize(ops: CarrierProbeOperations): Promise<void> {
  if (!ops.authorize)
    throw new Error('缺少管理员权限验证。')
  await ops.authorize()
}

async function tasks(ops: CarrierProbeOperations): Promise<AdminPingTask[]> {
  if (!ops.loadTasks)
    throw new Error('无法回查任务，已停止变更。')
  return ops.loadTasks()
}

function assertTaskSnapshot(task: AdminPingTask, liveTasks: readonly AdminPingTask[], label: string): void {
  const live = liveTasks.find(item => item.id === task.id)
  if (!live || carrierTaskSnapshot(live) !== carrierTaskSnapshot(task))
    throw new Error(`${label}已被删除或修改，请刷新并重新验证。`)
}

async function assertOriginal(task: AdminPingTask, ops: CarrierProbeOperations): Promise<void> {
  await authorize(ops)
  assertTaskSnapshot(task, await tasks(ops), '原任务')
}

/** Both resources must still match immediately before sending the destructive request. */
async function deleteOriginal(task: AdminPingTask, replacement: AdminPingTask, ops: CarrierProbeOperations): Promise<boolean> {
  await authorize(ops)
  const live = await tasks(ops)
  assertTaskSnapshot(task, live, '原任务')
  assertTaskSnapshot(replacement, live, '替代任务')
  try {
    return await ops.deleteTasks([task.id!])
  }
  catch {
    // A lost response is reconciled by the caller before deciding on compensation.
    return false
  }
}

async function rawSamples(id: number, clients: readonly string[], since: number, ops: CarrierProbeOperations): Promise<CarrierNodeSamples[]> {
  if (clients.some(client => ops.isOnline?.(client) === false))
    throw new Error('验证节点已离线，请重新选择在线节点验证。')
  const loaded = await ops.loadSamples(id, clients, since)
  const records = normalizeRawPingSamples(loaded.flatMap(item => item.records ?? []).filter(item => item.task_id === id && clients.includes(item.client)), since, ops.now())
  return clients.map((uuid) => {
    const own = records.filter(record => record.client === uuid)
    return { uuid, total: own.length, valid: own.filter(record => record.value >= 0).length, records: own }
  })
}

function fresh(samples: readonly CarrierNodeSamples[], now: number, interval = 30): boolean {
  return samples.length > 0 && samples.every((item) => {
    const last = item.records?.at(-1)
    return last && now - Date.parse(last.time) <= probeSampleFreshnessMs(interval)
  })
}

async function waitSamples(task: AdminPingTask, since: number, ops: CarrierProbeOperations, firstSuccess = false): Promise<CarrierNodeSamples[]> {
  const started = ops.now()
  let latest: CarrierNodeSamples[] = []
  for (let attempt = 0; attempt < 25 && ops.now() - started <= TIMEOUT_MS; attempt++) {
    const clients = firstSuccess ? task.clients.filter(client => ops.isOnline?.(client) !== false) : task.clients
    if (!clients.length)
      throw new Error('新任务所有来源节点已离线，无法确认首个成功样本。')
    latest = await rawSamples(task.id!, clients, since, ops)
    const count = latest.reduce((sum, sample) => sum + sample.total, 0)
    ops.progress?.('sampling', `已取得 ${count} 个样本；已等待 ${Math.floor((ops.now() - started) / 1000)} 秒`, task)
    if (firstSuccess ? latest.some(item => item.valid > 0) : fresh(latest, ops.now()) && assessCarrierProbeCandidate(latest).migratable)
      return latest
    if (attempt < 24)
      await ops.sleep(WAIT_MS)
  }
  throw new Error(`等待 4 分钟超时：${firstSuccess ? '新任务没有成功原始样本。' : assessCarrierProbeCandidate(latest).reason ?? '采样不完整。'}`)
}

/** Delete only an unchanged resource whose full snapshot was observed in this operation. */
async function cleanup(task: AdminPingTask, ops: CarrierProbeOperations): Promise<boolean> {
  try {
    await authorize(ops)
    const live = (await tasks(ops)).find(item => item.id === task.id)
    if (!live)
      return true
    if (carrierTaskSnapshot(live) !== carrierTaskSnapshot(task))
      return false
    if (await ops.deleteTasks([task.id!]))
      return true
    return !(await tasks(ops)).some(item => item.id === task.id)
  }
  catch { return false }
}

function checkCandidate(candidate: CarrierProbeCandidate): void {
  const normalized = buildCarrierProbeCandidate(candidate.type, candidate.host, candidate.port, candidate.source)
  if (!normalized || normalized.target !== candidate.target)
    throw new Error('候选目标无效或已修改，请重新验证。')
}

export async function runCarrierValidation(key: string, original: AdminPingTask, input: CarrierProbeCandidate, online: readonly string[], ops: CarrierProbeOperations): Promise<CarrierProbeCandidate> {
  const task = copyTask(original)
  const candidate = { ...input }
  checkCandidate(candidate)
  return (ops.withLock ?? withCarrierOperationLock)(task.id!, false, async () => {
    await assertOriginal(task, ops)
    const clients = [...new Set(online)].filter(uuid => task.clients.includes(uuid)).slice(0, 5)
    if (!clients.length)
      throw new Error('原任务没有在线节点可用于验证。')
    const createdAt = ops.now()
    ops.progress?.('creating', '正在创建临时任务；如请求中断，请回查而不要重复创建。')
    const canary = await ops.createTask({ name: `Transit-canary-${key}-${createdAt}`, clients, default_on: false, type: candidate.type, target: candidate.target, interval: 30 }, `carrier-canary:${key}:${createdAt}`)
    try {
      ops.progress?.('sampling', '临时任务已创建，等待原始样本。', canary)
      const verdict = assessCarrierProbeCandidate(await waitSamples(canary, createdAt, ops))
      recordTopologyWrite({ trigger: 'manual', action: `验证候选目标 ${task.name}`, outcome: 'ok', detail: verdict.reason })
      return { ...candidate, ...verdict, canaryTaskId: canary.id, canaryTaskName: canary.name, createdAt, expiresAt: createdAt + TTL_MS, originalSnapshot: carrierTaskSnapshot(task), candidateFingerprint: `${candidate.type}:${candidate.target}`, evidenceClients: clients }
    }
    catch (error) {
      const removed = await cleanup(canary, ops)
      throw new Error(`${reason(error)}${removed ? '' : ` 临时任务 ${canary.id} 清理未确认，请回查。`}`)
    }
  })
}

export async function runCarrierMigration(original: AdminPingTask, input: CarrierProbeCandidate, ops: CarrierProbeOperations): Promise<CarrierProbeMigrationResult> {
  const task = copyTask(original)
  const candidate = { ...input, evidenceClients: input.evidenceClients ? [...input.evidenceClients] : [] }
  const oldTaskId = task.id!
  const run = async (): Promise<CarrierProbeMigrationResult> => {
    let replacement: AdminPingTask | null = null
    let canary: AdminPingTask | undefined
    let deletingOld = false
    let oldDeleted = false
    try {
      checkCandidate(candidate)
      if (!Number.isInteger(oldTaskId) || oldTaskId <= 0)
        throw new Error('当前任务缺少有效 ID。')
      ops.progress?.('checking', '正在核对权限、原任务和候选样本。')
      await assertOriginal(task, ops)
      if (candidate.source !== 'current') {
        if (!candidate.createdAt || !candidate.expiresAt || ops.now() >= candidate.expiresAt || candidate.expiresAt !== candidate.createdAt + TTL_MS
          || candidate.originalSnapshot !== carrierTaskSnapshot(task) || candidate.candidateFingerprint !== `${candidate.type}:${candidate.target}`) {
          throw new Error('验证已过期或任务/候选已改变，请重新验证。')
        }
        const liveCanary = (await tasks(ops)).find(item => item.id === candidate.canaryTaskId)
        if (!liveCanary || liveCanary.name !== candidate.canaryTaskName || !liveCanary.name.startsWith('Transit-canary-')
          || liveCanary.target !== candidate.target || liveCanary.type !== candidate.type || liveCanary.interval !== 30 || liveCanary.default_on
          || JSON.stringify([...liveCanary.clients].sort()) !== JSON.stringify([...candidate.evidenceClients].sort())
          || !liveCanary.clients.length || liveCanary.clients.length > 5 || liveCanary.clients.some(uuid => !task.clients.includes(uuid))) {
          throw new Error('临时验证任务已改变或不存在，请重新验证。')
        }
        // Only an unchanged verified canary belongs to this operation's cleanup set.
        canary = liveCanary
        const evidence = await rawSamples(canary.id!, canary.clients, candidate.createdAt, ops)
        if (!fresh(evidence, ops.now()) || !assessCarrierProbeCandidate(evidence).migratable)
          throw new Error('候选最新原始样本不再满足迁移门槛，请重新验证。')
        ops.progress?.('checking', '候选仍满足门槛。', canary)
      }
      else if (candidate.type !== task.type || candidate.target !== task.target) {
        throw new Error('重建不能改变当前目标。')
      }
      await assertOriginal(task, ops)
      const createdAt = ops.now()
      ops.progress?.('creating', '正在创建替代任务；请求中断后请先回查。')
      replacement = copyTask(await ops.createTask({ name: task.name, clients: task.clients, default_on: Boolean(task.default_on), type: candidate.type, target: candidate.target, interval: task.interval }, `carrier-migrate:${oldTaskId}:${createdAt}`))
      ops.progress?.('sampling', '替代任务已创建，等待首个成功样本。', replacement)
      await waitSamples(replacement, createdAt, ops, true)
      ops.progress?.('deleting', '新任务已有成功样本，正在删除旧任务。')
      deletingOld = true
      oldDeleted = await deleteOriginal(task, replacement, ops)
      if (!oldDeleted) {
        const live = await tasks(ops)
        if (!live.some(item => item.id === oldTaskId))
          oldDeleted = true
        else
          throw new Error('旧任务清理失败。')
      }
      const remaining = canary && !await cleanup(canary, ops) ? [canary.id!] : []
      const message = `${candidate.source === 'current' ? '当前任务已用新 ID 重建' : '目标迁移成功'}，旧历史已隔离。${remaining.length ? `临时任务 ${remaining.join('、')} 清理未确认。` : ''}`
      recordTopologyWrite({ trigger: 'manual', action: `迁移监测目标 ${task.name}`, outcome: remaining.length ? 'failed' : 'ok', detail: message })
      return { ok: remaining.length === 0, oldTaskId, newTaskId: replacement.id, remainingTaskIds: remaining, message }
    }
    catch (error) {
      let oldPresent: boolean | null = null
      try {
        oldPresent = (await tasks(ops)).some(item => item.id === oldTaskId)
      }
      catch {}
      const remaining: number[] = []
      // A journal write failure must not prevent compensation or leave a rejected promise.
      try {
        ops.progress?.('cleanup', '操作未完成，正在确认本次资源和旧任务。')
      }
      catch {}
      // Once old deletion may have committed, ambiguity must preserve the working replacement.
      if (replacement && (!oldPresent || oldDeleted || (deletingOld && oldPresent === null) || !await cleanup(replacement, ops)))
        remaining.push(replacement.id!)
      if (canary && !await cleanup(canary, ops))
        remaining.push(canary.id!)
      const message = `迁移未完成：${reason(error)} ${oldPresent === true ? '旧任务已保留。' : oldPresent === false ? '旧任务已不存在，保留替代任务，请回查。' : '旧任务状态未确认，请回查。'}${remaining.length ? ` 保留/待处理任务：${remaining.join('、')}。` : ''}`
      recordTopologyWrite({ trigger: 'manual', action: `迁移监测目标 ${task.name}`, outcome: 'failed', detail: message })
      return { ok: false, oldTaskId, newTaskId: replacement?.id, remainingTaskIds: remaining, message }
    }
  }
  try {
    return await (ops.withLock ?? withCarrierOperationLock)(oldTaskId, true, run)
  }
  catch (error) { return { ok: false, oldTaskId, message: reason(error) } }
}
