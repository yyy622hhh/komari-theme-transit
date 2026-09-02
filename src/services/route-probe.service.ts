/**
 * 三网回程采集的编排：下发命令 → 等结果 → 判线 → 保存到 Transit 主题数据。
 *
 * 这是主题里唯一会在运营者服务器上**执行命令**的地方，比自动修复探测更重一档，
 * 所以约束也更严：
 *
 * - 命令是编译期常量（见 `utils/routeTrace.ts`），节点 UUID 只进 `clients` 数组；
 * - 只挑「在线 且 结果缺失或已过期」的节点，回程几周才变一次，这个条件天然把
 *   频率压到每台每周一次，不需要给运营者任何频率旋钮；
 * - 每次下发和写回都记进 `topologyWriteLog`，和自动修复共用同一个流水面板；
 * - 新结果不再写入 Komari 的用户标签；发现旧 `transit-route:` 时先持久化再清理，
 *   且不碰运营者自己的标签。
 */

import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { NodeInfo } from '@/utils/api.types'
import type { RouteProbeResults } from '@/utils/routeProbeResults'
import type { RouteTraceCity } from '@/utils/routeTrace'
import { requirePermission, setAuthSessionFromLogin } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import {
  enqueueCompanionRouteProbe,
  getCompanionRouteProbeBatch,
  RouteProbeCompanionError,
  RouteProbeCompanionUnavailableError,
} from '@/services/route-probe-companion.service'
import { classifyCompanionJobFailure, waitForRouteProbe } from '@/services/route-probe-execution.service'
import { cleanupPersistedLegacyRouteTag, saveRouteProbeResults } from '@/services/route-probe-results.service'
import { getRegionCode } from '@/utils/regionHelper'
import { resolveNodeRouteTag } from '@/utils/routeProbeResults'
import { formatNodeRouteTag, isNodeRouteTag, parseNodeRouteTag } from '@/utils/routeTag'
import { buildRouteTraceCommand, isMissingTracerouteOutput, isUsableRouteTraceOutput, parseRouteTraceOutput } from '@/utils/routeTrace'
import { getSharedRpc, isRpcPermissionError } from '@/utils/rpc'
import { logAppWarning } from '@/utils/safeError'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

/** 一次采集能覆盖的节点上限。一次下发太多会让服务端同时推送过多命令。 */
export const ROUTE_PROBE_MAX_NODES = 20

/** 等结果的总时限。三家各最多 30 跳、每跳 1 秒超时，最坏接近 90 秒。 */
const RESULT_TIMEOUT_MS = 150_000
const RESULT_POLL_INTERVAL_MS = 5_000
// Companion jobs can queue during helper backoff, then use a 180s lease (150s
// collection plus upload). Follow the coordinator's full 10-minute job TTL,
// with transport/polling margin, instead of applying the legacy exec deadline.
const COMPANION_RESULT_TIMEOUT_MS = 10 * 60_000 + 30_000

export interface RouteProbeCandidate {
  uuid: string
  name: string
}

export interface RouteProbeOutcome {
  uuid: string
  name: string
  status: 'updated' | 'updated-cleanup-pending' | 'helper-offline' | 'remote-disabled' | 'no-traceroute' | 'failed' | 'timeout'
  detail?: string
}

export interface RouteProbeSummary {
  taskId: string
  outcomes: RouteProbeOutcome[]
}

export interface RouteProbePersistence {
  theme: string
  activeNodeIds?: readonly string[]
  onPublicSettings?: PublicSettingsUpdater
}

interface RouteProbeRunOptions {
  trigger: 'manual' | 'auto'
  signal?: AbortSignal
  /**
   * 必填。写回只走 Transit 主题数据这一条路径——没有调用方还需要直接改节点
   * `tags` 的理由，把它做成可选参数只会让「忘记传」在类型层面悄悄放行，
   * 静默退回旧的 `editClient` 覆盖路径。
   */
  persistence: RouteProbePersistence
}

export type ProbeNode = Pick<NodeInfo, 'uuid' | 'name' | 'region' | 'tags'> & { online?: boolean }

/**
 * 节点是否满足回程检测的「在线、可探测」前提：有 uuid 且不是明确离线。
 *
 * 地区豁免（大陆）故意不放在这里判断——设置向导要把大陆节点单独计数展示，
 * 而不是和「离线/没 uuid」一样直接丢弃，所以留给调用方单独判断。这个前提本身
 * 被 `selectRouteProbeCandidates`（真正下发探测）和向导的环境检查共用，抽出来
 * 是为了不让两边的口径各自漂移。
 */
export function isRouteProbeOnlineNode<T extends { uuid?: string, online?: boolean }>(
  node: T,
): node is T & { uuid: string } {
  return Boolean(node.uuid) && node.online !== false
}

export function pickNodeAgentTokens(
  clients: Record<string, { token?: string }>,
  uuids: readonly string[],
): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const uuid of new Set(uuids.map(id => id.trim()).filter(Boolean))) {
    const token = clients[uuid]?.token?.trim()
    if (token)
      tokens[uuid] = token
  }
  return tokens
}

/** 只返回指定节点的 Agent token。Komari 没有按 UUID 取 token 的接口，整表拉取后在本地过滤。 */
export async function loadRouteProbeNodeTokens(
  uuids: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const wanted = [...new Set(uuids.map(id => id.trim()).filter(Boolean))]
  if (!wanted.length)
    return {}
  const permission = await requirePermission('advancedTools', { force: false })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后再试。')
  const clients = await requestManager.run('route-probe:node-tokens', requestSignal => (
    getSharedRpc().getNodesOverHttp(requestSignal)
  ), { retryAttempts: 0, signal })
  return pickNodeAgentTokens(clients, wanted)
}

/**
 * 挑出该采集的节点：在线，且没有回程结果或结果已经过期。
 *
 * 这是自动和默认手动路径的「频率控制」全部内容——没有单独的计时器，也没有给
 * 运营者的间隔设置。标签自带采集时间，过期阈值复用展示层那一套，判断和显示
 * 永远一致。`force` 只供运营者手动点按钮时使用：跳过新鲜度这一条，但在线、
 * 非中国大陆、台数上限这几条硬约束仍然生效——这些约束和「多久测一次」无关，
 * 不该被绕过。
 */
export function selectRouteProbeCandidates(
  nodes: readonly ProbeNode[],
  now = Date.now(),
  /**
   * 本轮不该再试的节点。必须在这里排除、而不是等调用方拿到结果后再过滤：
   * 台数上限是在这个函数里截断的，先截断后过滤会让排在前面的失败节点反复占满
   * 名额，后面的节点一次也轮不到。
   */
  skip: ReadonlySet<string> = new Set(),
  force = false,
  storedResults: RouteProbeResults = {},
): RouteProbeCandidate[] {
  const candidates: RouteProbeCandidate[] = []
  for (const node of nodes) {
    // 三网“回程线路”描述的是境外节点回到中国大陆时走哪条国际骨干。大陆节点到
    // 国内目标通常只经过云厂商内网和本地接入网，既没有可判定的国际骨干 ASN，
    // 也没有这项指标的实际含义；把它们送去采集只会稳定地产生空结果与失败提示。
    if (!isRouteProbeOnlineNode(node) || skip.has(node.uuid) || getRegionCode(node.region) === 'CN')
      continue
    if (!force) {
      const report = parseNodeRouteTag(resolveNodeRouteTag(node.uuid, node.tags, storedResults), now)
      // 已有标签、还没过期、且知道是什么时候采的，才算不用重跑。采集时间未知时
      // 无从判断新鲜度，按「该重测」处理，否则这台机器会被永久钉在轮换之外。
      if (report && report.measuredAt !== null && report.freshness !== 'stale')
        continue
    }
    candidates.push({ uuid: node.uuid, name: node.name ?? node.uuid })
    if (candidates.length >= ROUTE_PROBE_MAX_NODES)
      break
  }
  return candidates
}

/** 把新的回程标签并进现有 tags，只替换保留前缀那一条。 */
export function mergeRouteTag(existingTags: string, routeTag: string): string {
  const kept = (existingTags ?? '')
    .split(';')
    .map(tag => tag.trim())
    .filter(tag => tag && !isNodeRouteTag(tag))
  kept.push(routeTag)
  return kept.join(';')
}

export interface LegacyRouteTagMigrationResult {
  stored: number
  cleaned: number
  cleanupFailed: number
}

/**
 * Move v1.4.1 route metadata out of Komari's visible tag column. Saving the
 * public Transit map happens first; a node tag is removed only after an equal
 * or newer result is durably present in theme settings.
 */
export async function migrateLegacyRouteTags(
  nodes: readonly ProbeNode[],
  persistence: RouteProbePersistence,
): Promise<LegacyRouteTagMigrationResult> {
  const incoming: RouteProbeResults = {}
  for (const node of nodes) {
    const report = parseNodeRouteTag(node.tags)
    if (node.uuid && report)
      incoming[node.uuid] = report.raw
  }
  const uuids = Object.keys(incoming)
  if (!uuids.length)
    return { stored: 0, cleaned: 0, cleanupFailed: 0 }

  const saved = await saveRouteProbeResults({ ...persistence, results: incoming })
  let cleaned = 0
  let cleanupFailed = 0

  for (const uuid of uuids) {
    const persistedTag = saved[uuid]
    if (!persistedTag) {
      cleanupFailed += 1
      continue
    }
    try {
      const warning = await cleanupPersistedLegacyRouteTag(uuid, persistedTag)
      if (warning)
        cleanupFailed += 1
      else
        cleaned += 1
    }
    catch (error) {
      if (isRpcPermissionError(error))
        setAuthSessionFromLogin(false)
      cleanupFailed += 1
    }
  }

  recordTopologyWrite({
    trigger: 'auto',
    action: '迁移旧回程标签',
    outcome: cleanupFailed ? 'failed' : 'ok',
    detail: `已保存 ${uuids.length} 台，已清理 ${cleaned} 台${cleanupFailed ? `，${cleanupFailed} 台待重试` : ''}`,
  })
  return { stored: uuids.length, cleaned, cleanupFailed }
}

/**
 * 把节点执行层的明确失败归因出来。远程控制关闭和没装 traceroute 都不是线路探测
 * 失败，必须告诉运营者具体该改哪里；其余没有分段标记的空输出才归普通失败。
 */
export function classifyRouteProbeOutputFailure(
  output: string,
): 'remote-disabled' | 'no-traceroute' | 'failed' | null {
  if (output.includes('Remote control is disabled.'))
    return 'remote-disabled'
  if (isMissingTracerouteOutput(output))
    return 'no-traceroute'
  if (!isUsableRouteTraceOutput(output))
    return 'failed'
  return null
}

/**
 * 跑一轮采集。返回逐节点的结果，调用方负责展示。
 *
 * 任何一台失败都不影响其余节点——一台机器没装 traceroute 不该拖垮整轮。
 */
export async function probeNodeRoutes(
  candidates: readonly RouteProbeCandidate[],
  city: RouteTraceCity,
  options: RouteProbeRunOptions,
): Promise<RouteProbeSummary | null> {
  if (!candidates.length)
    return null

  const permission = await requirePermission('advancedTools', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后再检测回程线路。')

  try {
    return await probeNodeRoutesViaCompanion(candidates, city, options)
  }
  catch (error) {
    // 兼容还没有安装伴生插件的现有 Komari：只在明确 404 时退回原来的固定命令
    // admin:exec 路径。插件已经接单后的任何错误都不能回退，否则同一节点可能同时
    // 跑两轮探测。关闭远程控制的节点仍然不会执行命令，只会收到明确失败原因。
    if (!(error instanceof RouteProbeCompanionUnavailableError))
      throw error
  }

  return probeNodeRoutesViaRemoteExec(candidates, city, options)
}

async function probeNodeRoutesViaCompanion(
  candidates: readonly RouteProbeCandidate[],
  city: RouteTraceCity,
  options: RouteProbeRunOptions,
): Promise<RouteProbeSummary> {
  const batch = await enqueueCompanionRouteProbe(candidates.map(candidate => candidate.uuid), city, options.signal)
  recordTopologyWrite({
    trigger: options.trigger,
    action: `节点助手三网回程检测（${candidates.length} 台）`,
    outcome: 'ok',
    detail: `批次 ${batch.batch_id}`,
  })

  const pending = new Map(candidates.map(candidate => [candidate.uuid, candidate]))
  const lastStates = new Map<string, { status: string, attempts: number }>()
  const outcomes: RouteProbeOutcome[] = []
  const deadline = Date.now() + COMPANION_RESULT_TIMEOUT_MS
  // 已经接单的批次不该因为一次瞬时的状态查询失败就整批判死——network 抖动或
  // 伴生插件重启都可能打断单次轮询，而任务本身仍在正常执行。只有连续失败超过
  // 这个容忍次数、或者插件明确回报「批次不存在」（404，enqueue 成功后只可能是
  // 真的丢了）时才放弃，避免和插件已接单的任务同时跑两轮。
  // 容忍 POLL_FAILURE_TOLERANCE 次失败：第 4 次（不是第 3 次）才真正放弃。
  const POLL_FAILURE_TOLERANCE = 3
  let consecutivePollFailures = 0

  while (pending.size && Date.now() < deadline) {
    let snapshot: Awaited<ReturnType<typeof getCompanionRouteProbeBatch>>
    try {
      snapshot = await getCompanionRouteProbeBatch(batch.batch_id, options.signal)
      consecutivePollFailures = 0
    }
    catch (error) {
      if (error instanceof RouteProbeCompanionError && error.status === 404)
        throw error
      consecutivePollFailures += 1
      if (consecutivePollFailures > POLL_FAILURE_TOLERANCE)
        throw error
      logAppWarning('route-probe-poll', error)
      await waitForRouteProbe(RESULT_POLL_INTERVAL_MS, options.signal)
      continue
    }

    const completed = snapshot.jobs.filter(job => pending.has(job.client)
      && (job.status === 'completed' || job.status === 'failed'))
    for (const job of snapshot.jobs)
      lastStates.set(job.client, { status: job.status, attempts: job.attempts })

    if (completed.length) {
      // 和旧远程执行路径一样，写回前读取一次最新标签，避免覆盖检测期间的并发修改。
      const latestClients = await getSharedRpc().getNodesOverHttp(options.signal)
      const writeRequests: RouteTagWriteRequest[] = []
      for (const job of completed) {
        const candidate = pending.get(job.client)
        if (!candidate)
          continue
        pending.delete(job.client)
        if (job.status === 'completed' && job.tag) {
          const validated = validateCompanionRouteTag(candidate, job.tag, latestClients[job.client]?.tags)
          if (validated.ok)
            writeRequests.push(validated.request)
          else
            outcomes.push(validated.outcome)
        }
        else {
          outcomes.push({ uuid: candidate.uuid, name: candidate.name, ...classifyCompanionJobFailure(job) })
        }
      }
      // 同一轮拿到结果的节点合并成一次主题数据保存，而不是每台各存一次。
      outcomes.push(...await writeRouteTagsBatch(writeRequests, options.trigger, options.persistence))
    }
    if (pending.size) {
      await waitForRouteProbe(RESULT_POLL_INTERVAL_MS, options.signal)
    }
  }

  for (const candidate of pending.values()) {
    const state = lastStates.get(candidate.uuid)
    const helperOffline = state?.attempts === 0 && state.status === 'queued'
    outcomes.push({
      uuid: candidate.uuid,
      name: candidate.name,
      status: helperOffline ? 'helper-offline' : 'timeout',
      detail: helperOffline ? '节点助手未安装、未启动或尚未连接' : '节点助手执行超时',
    })
  }
  return { taskId: `companion:${batch.batch_id}`, outcomes }
}

async function probeNodeRoutesViaRemoteExec(
  candidates: readonly RouteProbeCandidate[],
  city: RouteTraceCity,
  options: RouteProbeRunOptions,
): Promise<RouteProbeSummary> {
  const command = buildRouteTraceCommand(city)
  if (!command)
    throw new Error(`没有 ${city} 的三网测速点地址。`)

  const rpc = getSharedRpc()
  const uuids = candidates.map(candidate => candidate.uuid)

  const dispatch = await rpc.execCommand(command, uuids, options.signal)
  recordTopologyWrite({
    trigger: options.trigger,
    action: `下发三网回程检测（${candidates.length} 台）`,
    outcome: 'ok',
    detail: `任务 ${dispatch.task_id}`,
  })

  const pending = new Map(candidates.map(candidate => [candidate.uuid, candidate]))
  const outcomes: RouteProbeOutcome[] = []
  const deadline = Date.now() + RESULT_TIMEOUT_MS

  while (pending.size && Date.now() < deadline) {
    await waitForRouteProbe(RESULT_POLL_INTERVAL_MS, options.signal)

    const results = await rpc.getExecTaskResults(dispatch.task_id, options.signal)
    const completedResults = results.filter(result => result.finished_at && pending.has(result.client))
    if (!completedResults.length)
      continue

    // 远程命令最长可能跑两分多钟。期间管理员或另一个会话可能修改节点标签，不能
    // 再拿下发前保存在 candidate 里的旧 tags 覆盖写回。这里直接走 HTTP 重新读取
    // 当前节点信息；同一轮交回的所有节点共享这一次快照，避免逐节点重复请求。
    const latestClients = await rpc.getNodesOverHttp(options.signal)

    const writeRequests: RouteTagWriteRequest[] = []
    for (const result of completedResults) {
      const candidate = pending.get(result.client)
      if (!candidate)
        continue
      pending.delete(result.client)
      const validated = validateRouteResult(candidate, result.result ?? '', latestClients[result.client]?.tags)
      if (validated.ok)
        writeRequests.push(validated.request)
      else
        outcomes.push(validated.outcome)
    }
    // 同一轮交回结果的节点合并成一次主题数据保存，而不是每台各存一次。
    outcomes.push(...await writeRouteTagsBatch(writeRequests, options.trigger, options.persistence))
  }

  for (const candidate of pending.values())
    outcomes.push({ uuid: candidate.uuid, name: candidate.name, status: 'timeout', detail: '节点未在时限内交回结果' })

  return { taskId: dispatch.task_id, outcomes }
}

/** 一台节点已经通过校验、可以进入这一轮批量保存的回程结果。 */
interface RouteTagWriteRequest {
  candidate: RouteProbeCandidate
  routeTag: string
  /** 校验时读到的节点标签，只用来判断是否需要清理旧标签，不用于拼接写回内容。 */
  latestTags: string | undefined
}

type RouteTagValidation
  = | { ok: true, request: RouteTagWriteRequest }
    | { ok: false, outcome: RouteProbeOutcome }

function validateCompanionRouteTag(
  candidate: RouteProbeCandidate,
  routeTag: string,
  latestTags: string | undefined,
): RouteTagValidation {
  const report = parseNodeRouteTag(routeTag)
  const hasEvidence = report?.entries.some(entry => entry.asns.length)
  if (!report || report.raw !== routeTag || report.measuredAt === null || report.freshness === 'stale' || !hasEvidence) {
    return {
      ok: false,
      outcome: { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail: '节点助手返回了无效或过期的回程标签' },
    }
  }
  if (latestTags === undefined) {
    return {
      ok: false,
      outcome: { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail: '写回前未找到节点最新信息，已取消以避免覆盖标签' },
    }
  }
  return { ok: true, request: { candidate, routeTag, latestTags } }
}

function validateRouteResult(
  candidate: RouteProbeCandidate,
  output: string,
  latestTags: string | undefined,
): RouteTagValidation {
  const outputFailure = classifyRouteProbeOutputFailure(output)
  if (outputFailure) {
    const detail = {
      'remote-disabled': '节点已关闭 Komari 远程控制，可启用后重试或改用节点侧采集脚本',
      'no-traceroute': '节点未安装 traceroute',
      'failed': '未取得可用的探测输出',
    }[outputFailure]
    return { ok: false, outcome: { uuid: candidate.uuid, name: candidate.name, status: outputFailure, detail } }
  }

  const parsed = parseRouteTraceOutput(output)

  // 三家一个骨干跳都没认出来，更可能是这台机器的 traceroute 被拦或网络在抖，
  // 而不是回程真的变成了「未见骨干」。这种结果不写回：写了既会把上一次的好结果
  // 覆盖掉，又会让这台机器因为「标签还新鲜」而七天内不再重测。
  // 节点侧采集脚本有同样的守卫，两条路径的判断必须一致。
  if (Object.values(parsed).every(asns => !asns.length)) {
    return {
      ok: false,
      outcome: { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail: '三家均未识别到骨干跳点，判为采集失败' },
    }
  }

  if (latestTags === undefined) {
    return {
      ok: false,
      outcome: { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail: '写回前未找到节点最新信息，已取消以避免覆盖标签' },
    }
  }

  return { ok: true, request: { candidate, routeTag: formatNodeRouteTag(parsed, Date.now()), latestTags } }
}

/**
 * 把同一轮拿到结果的节点合并成一次主题数据保存，而不是逐台各存一次——每次
 * 保存都要整份重新读改写 `pandaOpsRouteProbeResults`，20 台一批时能差 20 倍。
 *
 * 清理旧 `transit-route:` 标签仍然逐台判断：只在这一轮读到的节点标签里确实
 * 有旧标签时才调用 `cleanupPersistedLegacyRouteTag`（它自己会再读一次最新
 * 标签防并发覆盖），迁移完成后的稳态下这一步整体不再发生。
 */
async function writeRouteTagsBatch(
  requests: readonly RouteTagWriteRequest[],
  trigger: 'manual' | 'auto',
  persistence: RouteProbePersistence,
): Promise<RouteProbeOutcome[]> {
  if (!requests.length)
    return []

  let saved: RouteProbeResults
  try {
    saved = await saveRouteProbeResults({
      ...persistence,
      results: Object.fromEntries(requests.map(request => [request.candidate.uuid, request.routeTag])),
    })
  }
  catch (error) {
    if (isRpcPermissionError(error))
      setAuthSessionFromLogin(false)
    const detail = error instanceof Error ? error.message : String(error)
    return requests.map((request) => {
      recordTopologyWrite({ trigger, action: `保存回程线路 ${request.candidate.name}`, outcome: 'failed', detail })
      return { uuid: request.candidate.uuid, name: request.candidate.name, status: 'failed', detail }
    })
  }

  return Promise.all(requests.map(async (request): Promise<RouteProbeOutcome> => {
    const { candidate, routeTag, latestTags } = request
    const savedTag = saved[candidate.uuid] ?? ''
    if (!savedTag) {
      // 探测窗口最长能到 10 分钟；这段时间里节点被隐藏、删除或分组变化都会让它
      // 掉出 activeNodeIds 白名单，`mergeRouteProbeResults` 据此把这条结果悄悄
      // 滤掉——那不是「服务器没存住」，说清楚原因才不会把运营者引向错误的排查
      // 方向（去查主题保存链路，而不是查节点当下还在不在列表里）。
      const droppedByAllowlist = persistence.activeNodeIds !== undefined
        && !persistence.activeNodeIds.some(id => id.trim() === candidate.uuid)
      const detail = droppedByAllowlist
        ? '节点在等待结果期间已不在当前节点列表中，回程结果未保留'
        : '服务器未保留回程结果'
      recordTopologyWrite({ trigger, action: `保存回程线路 ${candidate.name}`, outcome: 'failed', detail })
      return { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail }
    }
    recordTopologyWrite({ trigger, action: `保存回程线路 ${candidate.name}`, outcome: 'ok', detail: '已写入 Transit 主题数据' })

    if (!parseNodeRouteTag(latestTags))
      return { uuid: candidate.uuid, name: candidate.name, status: 'updated', detail: routeTag }

    try {
      const warning = await cleanupPersistedLegacyRouteTag(candidate.uuid, savedTag)
      if (warning) {
        recordTopologyWrite({ trigger, action: `清理旧回程标签 ${candidate.name}`, outcome: 'failed', detail: warning })
        return { uuid: candidate.uuid, name: candidate.name, status: 'updated-cleanup-pending', detail: warning }
      }
      return { uuid: candidate.uuid, name: candidate.name, status: 'updated', detail: routeTag }
    }
    catch (error) {
      if (isRpcPermissionError(error))
        setAuthSessionFromLogin(false)
      const detail = error instanceof Error ? error.message : String(error)
      recordTopologyWrite({ trigger, action: `清理旧回程标签 ${candidate.name}`, outcome: 'failed', detail })
      return {
        uuid: candidate.uuid,
        name: candidate.name,
        status: 'updated-cleanup-pending',
        detail: `回程结果已保存；旧标签清理失败：${detail}`,
      }
    }
  }))
}
