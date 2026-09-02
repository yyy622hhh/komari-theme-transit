import type { AdminPingTask } from '@/services/ping-task.model'
import type { ProbeCurrentState } from '@/utils/pingCurrentState'
import type { PingRecord, PingTaskMutation } from '@/utils/rpc'
import type { TopologyProbeOption } from '@/utils/topologyPresets'
import { OPS_ALERT_THRESHOLDS } from '@/constants/ops'
import { TIME_MS } from '@/constants/time'
import { requirePermission } from '@/services/auth.service'
import { runCarrierMigration, runCarrierValidation } from '@/services/carrier-probe-migration.service'
import { heldCarrierTaskIds } from '@/services/carrier-probe-operation.service'
import { loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, partitionMetricEntityIds, queryMetrics } from '@/services/metrics.service'
import { loadRawPingSamples } from '@/services/ping-raw-samples.service'
import { createAdminPingTask, deleteTopologyPingTasks, loadAdminPingTasks } from '@/services/ping-task.service'
import { PING_LOSS_METRIC } from '@/utils/metricSeries'
import { detectPingCommonModeLossKeys } from '@/utils/pingCommonMode'
import { hasCurrentCommonModeFailure, mergeProbeCurrentStates, normalizeRawPingSamples, resolveProbeCurrentState } from '@/utils/pingCurrentState'
import { normalizePingTaskName, normalizeTopologyProbeTarget, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

export type CarrierProbeHealthStatus = 'healthy' | 'single-path-anomaly' | 'shared-target-anomaly' | 'insufficient-evidence'

export interface CarrierProbeNode {
  uuid: string
  name: string
  online: boolean
}

export interface CarrierProbeHealth {
  key: string
  label: string
  status: CarrierProbeHealthStatus
  task: AdminPingTask | null
  currentTarget: string
  probeType: string
  assignedNodes: number
  onlineNodes: number
  sampledNodes: number
  sampleCount: number
  successRate: number | null
  abnormalNodeUuids: string[]
  commonModeEvents: number
  /** `null` when the built-in candidate is the task already running — nothing to verify against. */
  fallback: CarrierProbeCandidate | null
  current: ProbeCurrentState
  recovered: boolean
}

export interface CarrierProbeCandidate {
  type: 'icmp' | 'tcp'
  host: string
  port?: number
  target: string
  source: 'builtin' | 'custom' | 'current'
  canaryTaskId?: number
  canaryTaskName?: string
  successRate?: number
  lowConfidence?: boolean
  migratable?: boolean
  reason?: string
  createdAt?: number
  expiresAt?: number
  originalSnapshot?: string
  candidateFingerprint?: string
  evidenceClients?: string[]
}

export interface CarrierProbeMigrationResult {
  ok: boolean
  oldTaskId: number
  newTaskId?: number
  message: string
  remainingTaskIds?: number[]
}

export interface CarrierNodeSamples {
  uuid: string
  total: number
  valid: number
  records?: PingRecord[]
}

interface HealthEvidence {
  onlineNodes: number
  observations: CarrierNodeSamples[]
  commonModeEvents: number
}

export interface CarrierProbeOperations {
  authorize?: () => Promise<void>
  now: () => number
  sleep: (ms: number) => Promise<void>
  createTask: (mutation: PingTaskMutation, key: string) => Promise<AdminPingTask>
  deleteTasks: (ids: readonly number[]) => Promise<boolean>
  loadTasks?: () => Promise<AdminPingTask[]>
  loadSamples: (taskId: number, clients: readonly string[], since?: number) => Promise<CarrierNodeSamples[]>
  withLock?: <T>(taskId: number, mutation: boolean, run: () => Promise<T>) => Promise<T>
  isOnline?: (client: string) => boolean
  progress?: (phase: import('@/services/carrier-probe-operation.service').CarrierOperationPhase, message: string, created?: AdminPingTask) => void
}

const CANARY_PREFIX = 'Transit-canary-'
const CANARY_TTL_MS = 30 * TIME_MS.minute
const MIN_NODE_SAMPLES = 3
const SINGLE_NODE_SAMPLES = 5
const MIGRATION_SUCCESS_RATE = 0.95

function taskId(task: Pick<AdminPingTask, 'id'>): number | null {
  return Number.isInteger(task.id) && task.id! > 0 ? task.id! : null
}

function aggregateSamples(samples: readonly CarrierNodeSamples[]): { total: number, valid: number } {
  return samples.reduce((sum, item) => ({ total: sum.total + item.total, valid: sum.valid + item.valid }), { total: 0, valid: 0 })
}

export function classifyCarrierProbeHealth(evidence: HealthEvidence): CarrierProbeHealthStatus {
  const sampled = evidence.observations.filter(item => item.total >= MIN_NODE_SAMPLES)
  if (evidence.onlineNodes <= 0 || sampled.length <= 0)
    return 'insufficient-evidence'
  if (evidence.commonModeEvents > 0 && sampled.length >= OPS_ALERT_THRESHOLDS.carrierCommonMode.minAffectedNodes)
    return 'shared-target-anomaly'
  if (sampled.some(item => item.valid / item.total < MIGRATION_SUCCESS_RATE))
    return 'single-path-anomaly'
  if (evidence.onlineNodes < 2 || sampled.length < evidence.onlineNodes)
    return 'insufficient-evidence'
  return 'healthy'
}

export function buildCarrierProbeCandidate(
  type: 'icmp' | 'tcp',
  rawHost: string,
  port: number | undefined,
  source: CarrierProbeCandidate['source'],
): CarrierProbeCandidate | null {
  const host = normalizeTopologyProbeTarget(rawHost)
  // v1.4.0 deliberately does not add IPv6 candidate probing.
  if (!host || host.includes(':'))
    return null
  if (type === 'tcp' && (!Number.isInteger(port) || port! < 1 || port! > 65_535))
    return null
  return {
    type,
    host,
    ...(type === 'tcp' ? { port } : {}),
    target: type === 'tcp' ? `${host}:${port}` : host,
    source,
  }
}

export function assessCarrierProbeCandidate(samples: readonly CarrierNodeSamples[]): Pick<CarrierProbeCandidate, 'migratable' | 'lowConfidence' | 'successRate' | 'reason'> {
  if (!samples.length)
    return { migratable: false, lowConfidence: false, reason: '还没有在线节点样本。' }
  const lowConfidence = samples.length === 1
  const required = lowConfidence ? SINGLE_NODE_SAMPLES : MIN_NODE_SAMPLES
  if (samples.some(item => item.total < required))
    return { migratable: false, lowConfidence, reason: `每台节点至少需要 ${required} 个样本。` }
  if (samples.some(item => item.valid === 0))
    return { migratable: false, lowConfidence, successRate: 0, reason: '至少一台节点全部失败。' }
  const totals = aggregateSamples(samples)
  const successRate = totals.total > 0 ? totals.valid / totals.total : 0
  if (lowConfidence) {
    const recent = normalizeRawPingSamples(samples[0]!.records ?? []).slice(-SINGLE_NODE_SAMPLES)
    if (recent.length !== SINGLE_NODE_SAMPLES || recent.some(record => record.value < 0))
      return { migratable: false, lowConfidence, successRate, reason: '尚未取得最近连续 5 个成功的原始样本。' }
  }
  else if (successRate < MIGRATION_SUCCESS_RATE) {
    return { migratable: false, lowConfidence, successRate, reason: '总体成功率低于 95%。' }
  }
  return {
    migratable: true,
    lowConfidence,
    successRate,
    reason: lowConfidence ? '连续 5 次成功，但只有一台在线节点，结论为低置信度。' : '候选目标已达到迁移门槛。',
  }
}

function isCarrierTask(task: AdminPingTask, option: TopologyProbeOption): boolean {
  const normalized = normalizePingTaskName(task.name)
  return !task.name.startsWith(CANARY_PREFIX)
    && [option.taskFilter, option.label].some(alias => normalizePingTaskName(alias) === normalized)
}

export function selectCarrierProbeTask(
  tasks: readonly AdminPingTask[],
  option: TopologyProbeOption,
  samplesByTaskId: ReadonlyMap<number, readonly CarrierNodeSamples[]> = new Map(),
): AdminPingTask | null {
  const rank = (task: AdminPingTask): number => {
    const id = taskId(task)
    if (id === null)
      return 0
    const samples = samplesByTaskId.get(id) ?? []
    return samples.some(sample => sample.valid > 0) ? 1 : 0
  }
  return tasks
    .filter(task => isCarrierTask(task, option))
    .sort((left, right) => rank(right) - rank(left) || (right.id ?? 0) - (left.id ?? 0))[0] ?? null
}

async function loadTaskSamples(taskIdValue: number, clients: readonly string[]): Promise<CarrierNodeSamples[]> {
  const uniqueClients = [...new Set(clients.map(value => value.trim()).filter(Boolean))]
  if (!uniqueClients.length)
    return []
  try {
    const responses = await Promise.all(partitionMetricEntityIds(uniqueClients).map(entityIds => loadPingMetricStats({
      entity_ids: entityIds,
      hours: 1,
      max_points: 240,
    })))
    const byClient = new Map<string, CarrierNodeSamples>()
    for (const stat of responses.flatMap(response => response.stats)) {
      if (String(stat.task_id) !== String(taskIdValue) || !uniqueClients.includes(stat.entity_id))
        continue
      byClient.set(stat.entity_id, {
        uuid: stat.entity_id,
        total: Number.isFinite(stat.total) ? stat.total : 0,
        valid: Number.isFinite(stat.valid) ? stat.valid : 0,
      })
    }
    return uniqueClients.map(uuid => byClient.get(uuid) ?? { uuid, total: 0, valid: 0 })
  }
  catch {
    const records = (await loadPingRecordsWithTasks(1, 240).catch(() => ({ records: [] as PingRecord[], tasks: [] }))).records
    return uniqueClients.map((uuid) => {
      const matching = records.filter(record => record.client === uuid && record.task_id === taskIdValue)
      return { uuid, total: matching.length, valid: matching.filter(record => Number.isFinite(record.value) && record.value >= 0).length }
    })
  }
}

export const defaultCarrierProbeOperations: CarrierProbeOperations = {
  authorize: assertCarrierProbePermission,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  createTask: (mutation, key) => createAdminPingTask(mutation, { requestKey: key }),
  deleteTasks: ids => deleteTopologyPingTasks(ids),
  loadTasks: () => loadAdminPingTasks({ fresh: true, requestKey: `carrier-migrate:reconcile:${Date.now()}` }),
  loadSamples: async (id, clients, since = Date.now() - 3_600_000) => {
    const records = await loadRawPingSamples(clients, since, id)
    return clients.map((uuid) => {
      const own = records.filter(record => record.client === uuid)
      return { uuid, total: own.length, valid: own.filter(record => record.value >= 0).length, records: own }
    })
  },
}

async function assertCarrierProbePermission(): Promise<void> {
  const permission = await requirePermission('advancedTools', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后管理监测目标。')
}

export function staleTransitCanaryTaskIds(tasks: readonly AdminPingTask[], now = Date.now()): number[] {
  const pattern = /^Transit-canary-([a-z]+(?:-[a-z]+)*)-(\d{13})$/
  const knownKeys = new Set(TOPOLOGY_PROBE_OPTIONS.map(option => option.key))
  return tasks.flatMap((task) => {
    const match = pattern.exec(task.name.trim())
    const id = taskId(task)
    if (!match || id === null || !knownKeys.has(match[1]!) || now - Number(match[2]) <= CANARY_TTL_MS)
      return []
    return [id]
  })
}

export async function cleanupStaleTransitCanaries(): Promise<number> {
  await assertCarrierProbePermission()
  const tasks = await loadAdminPingTasks({ fresh: true, requestKey: 'carrier-health:cleanup:list' })
  const held = await heldCarrierTaskIds()
  const ids = staleTransitCanaryTaskIds(tasks)
    .filter(id => !held.has(id))
  if (!ids.length)
    return 0
  const deleted = await deleteTopologyPingTasks(ids)
  if (deleted)
    recordTopologyWrite({ trigger: 'auto', action: '清理过期监测候选任务', outcome: 'ok', detail: `${ids.length} 个` })
  return deleted ? ids.length : 0
}

async function loadAllTaskSamples(tasks: readonly AdminPingTask[], nodes: readonly CarrierProbeNode[]): Promise<Map<number, CarrierNodeSamples[]>> {
  const online = new Set(nodes.filter(node => node.online).map(node => node.uuid))
  const entries = await Promise.all(tasks.flatMap((task) => {
    const id = taskId(task)
    if (id === null)
      return []
    const clients = task.clients.filter(uuid => online.has(uuid))
    return [loadTaskSamples(id, clients).then(samples => [id, samples] as const)]
  }))
  return new Map(entries)
}

async function loadCommonModeCounts(nodes: readonly CarrierProbeNode[]): Promise<Map<number, number>> {
  const clients = nodes.filter(node => node.online).map(node => node.uuid)
  if (!clients.length)
    return new Map()
  try {
    const responses = await Promise.all(partitionMetricEntityIds(clients).map(entityIds => queryMetrics({
      metric_keys: [PING_LOSS_METRIC],
      entity_ids: entityIds,
      hours: 1,
      downsample: true,
      fill_empty: true,
      max_points: 240,
      aggregation: 'avg',
    })))
    const keys = detectPingCommonModeLossKeys(responses.flatMap(response => response.series))
    const counts = new Map<number, number>()
    for (const key of keys) {
      const id = Number(key.slice(0, key.indexOf(':')))
      if (Number.isInteger(id))
        counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }
  catch {
    return new Map()
  }
}

export async function loadCarrierProbeHealth(nodes: readonly CarrierProbeNode[]): Promise<CarrierProbeHealth[]> {
  await assertCarrierProbePermission()
  const tasks = await loadAdminPingTasks({ fresh: true, requestKey: 'carrier-health:list' })
  const now = Date.now()
  const [samplesByTaskId, commonModeByTaskId, raw] = await Promise.all([
    loadAllTaskSamples(tasks.filter(task => TOPOLOGY_PROBE_OPTIONS.some(option => isCarrierTask(task, option))), nodes),
    loadCommonModeCounts(nodes),
    loadRawPingSamples(nodes.filter(node => node.online).map(node => node.uuid), Math.floor(now / 60_000) * 60_000 - 3_600_000).catch(() => [] as PingRecord[]),
  ])
  const nodeById = new Map(nodes.map(node => [node.uuid, node]))

  return TOPOLOGY_PROBE_OPTIONS.map((option) => {
    const task = selectCarrierProbeTask(tasks, option, samplesByTaskId)
    const id = task ? taskId(task) : null
    const onlineClients = task?.clients.filter(uuid => nodeById.get(uuid)?.online) ?? []
    const observations = id === null ? [] : samplesByTaskId.get(id) ?? []
    const totals = aggregateSamples(observations)
    const abnormal = observations.filter(item => item.total >= MIN_NODE_SAMPLES && item.valid / item.total < MIGRATION_SUCCESS_RATE)
    const commonModeEvents = id === null ? 0 : commonModeByTaskId.get(id) ?? 0
    const builtinCandidate = buildCarrierProbeCandidate('icmp', option.landmarkAddress, undefined, 'builtin')!
    const runningCandidate = task ? currentCarrierProbeCandidate(task) : null
    // Verifying the exact target the task already polls tells the operator nothing:
    // it would spend a canary task and up to 4 minutes to "discover" the status
    // already shown above. Only offer it once it actually differs.
    const fallback = runningCandidate && runningCandidate.type === builtinCandidate.type && runningCandidate.target === builtinCandidate.target
      ? null
      : builtinCandidate
    const taskRecords = raw.filter(record => record.task_id === id)
    const current = task?.clients.length && !onlineClients.length
      ? resolveProbeCurrentState(taskRecords, { online: false, now })
      : mergeProbeCurrentStates(onlineClients.map(client => resolveProbeCurrentState(taskRecords.filter(record => record.client === client), { interval: task?.interval, now })))
    const sharedFailure = hasCurrentCommonModeFailure(taskRecords, onlineClients, task?.interval ?? 30, now)
    const status: CarrierProbeHealthStatus = sharedFailure
      ? 'shared-target-anomaly'
      : current.status === 'failed' || current.status === 'intermittent'
        ? 'single-path-anomaly'
        : current.status === 'healthy' && onlineClients.length >= 2 ? 'healthy' : 'insufficient-evidence'
    return {
      key: option.key,
      label: option.label,
      status,
      current,
      recovered: current.status === 'healthy' && (commonModeEvents > 0 || totals.valid < totals.total),
      task,
      currentTarget: task?.target ?? '',
      probeType: task?.type ?? '',
      assignedNodes: task?.clients.length ?? 0,
      onlineNodes: onlineClients.length,
      sampledNodes: observations.filter(item => item.total >= MIN_NODE_SAMPLES).length,
      sampleCount: totals.total,
      successRate: totals.total > 0 ? totals.valid / totals.total : null,
      abnormalNodeUuids: abnormal.map(item => item.uuid),
      commonModeEvents,
      fallback,
    }
  })
}

export async function validateCarrierProbeCandidate(
  profileKey: string,
  currentTask: AdminPingTask,
  candidate: CarrierProbeCandidate,
  onlineClientUuids: readonly string[],
  operations: CarrierProbeOperations = defaultCarrierProbeOperations,
): Promise<CarrierProbeCandidate> {
  return runCarrierValidation(profileKey, currentTask, candidate, onlineClientUuids, operations)
}

export async function migrateCarrierProbeTask(
  currentTask: AdminPingTask,
  candidate: CarrierProbeCandidate,
  operations: CarrierProbeOperations = defaultCarrierProbeOperations,
): Promise<CarrierProbeMigrationResult> {
  return runCarrierMigration(currentTask, candidate, operations)
}

export function currentCarrierProbeCandidate(task: AdminPingTask): CarrierProbeCandidate | null {
  const type = task.type === 'tcp' ? 'tcp' : task.type === 'icmp' ? 'icmp' : null
  if (!type)
    return null
  const match = type === 'tcp' ? /^(.*):(\d+)$/.exec(task.target.trim()) : null
  return buildCarrierProbeCandidate(type, match?.[1] ?? task.target, match ? Number(match[2]) : undefined, 'current')
}
