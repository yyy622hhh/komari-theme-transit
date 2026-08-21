/**
 * 三网回程采集的编排：下发命令 → 等结果 → 判线 → 写回节点 `tags`。
 *
 * 这是主题里唯一会在运营者服务器上**执行命令**的地方，比自动修复探测更重一档，
 * 所以约束也更严：
 *
 * - 命令是编译期常量（见 `utils/routeTrace.ts`），节点 UUID 只进 `clients` 数组；
 * - 只挑「在线 且 标签缺失或已过期」的节点，回程几周才变一次，这个条件天然把
 *   频率压到每台每周一次，不需要给运营者任何频率旋钮；
 * - 每次下发和写回都记进 `topologyWriteLog`，和自动修复共用同一个流水面板；
 * - 写回前先读现有 tags，只替换 `transit-route:` 那一条，不碰运营者自己的标签。
 */

import type { NodeInfo } from '@/utils/api.types'
import type { RouteTraceCity } from '@/utils/routeTrace'
import { requirePermission } from '@/services/auth.service'
import { formatNodeRouteTag, isNodeRouteTag, parseNodeRouteTag } from '@/utils/routeTag'
import { buildRouteTraceCommand, isMissingTracerouteOutput, isUsableRouteTraceOutput, parseRouteTraceOutput } from '@/utils/routeTrace'
import { getSharedRpc } from '@/utils/rpc'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

/** 一次采集能覆盖的节点上限。一次下发太多会让服务端同时推送过多命令。 */
export const ROUTE_PROBE_MAX_NODES = 20

/** 等结果的总时限。三家各最多 30 跳、每跳 1 秒超时，最坏接近 90 秒。 */
const RESULT_TIMEOUT_MS = 150_000
const RESULT_POLL_INTERVAL_MS = 5_000

export interface RouteProbeCandidate {
  uuid: string
  name: string
  tags: string
}

export interface RouteProbeOutcome {
  uuid: string
  name: string
  status: 'updated' | 'no-traceroute' | 'failed' | 'timeout'
  detail?: string
}

export interface RouteProbeSummary {
  taskId: string
  outcomes: RouteProbeOutcome[]
}

type ProbeNode = Pick<NodeInfo, 'uuid' | 'name' | 'tags'> & { online?: boolean }

/**
 * 挑出该采集的节点：在线，且没有回程标签或标签已经过期。
 *
 * 这里就是「频率控制」的全部——没有单独的计时器，也没有给运营者的间隔设置。
 * 标签自带采集时间，过期阈值复用展示层那一套，判断和显示永远一致。
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
): RouteProbeCandidate[] {
  const candidates: RouteProbeCandidate[] = []
  for (const node of nodes) {
    if (node.online === false || !node.uuid || skip.has(node.uuid))
      continue
    const report = parseNodeRouteTag(node.tags, now)
    // 已有标签、还没过期、且知道是什么时候采的，才算不用重跑。采集时间未知时
    // 无从判断新鲜度，按「该重测」处理，否则这台机器会被永久钉在轮换之外。
    if (report && report.measuredAt !== null && report.freshness !== 'stale')
      continue
    candidates.push({ uuid: node.uuid, name: node.name ?? node.uuid, tags: node.tags ?? '' })
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 跑一轮采集。返回逐节点的结果，调用方负责展示。
 *
 * 任何一台失败都不影响其余节点——一台机器没装 traceroute 不该拖垮整轮。
 */
export async function probeNodeRoutes(
  candidates: readonly RouteProbeCandidate[],
  city: RouteTraceCity,
  options: { trigger: 'manual' | 'auto', signal?: AbortSignal } = { trigger: 'manual' },
): Promise<RouteProbeSummary | null> {
  if (!candidates.length)
    return null

  const permission = await requirePermission('advancedTools', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后再检测回程线路。')

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
    await sleep(RESULT_POLL_INTERVAL_MS)
    if (options.signal?.aborted)
      break

    const results = await rpc.getExecTaskResults(dispatch.task_id, options.signal)
    for (const result of results) {
      const candidate = pending.get(result.client)
      if (!candidate)
        continue
      // 只认已完成的行。当前 Komari 只在节点离线时预写占位（那条带真实时间戳），
      // 但接口的类型允许 finished_at 为空；真出现未完成占位时，若照单全收就会把
      // 整批节点判成失败，而且它们已经从 pending 里删掉了，后续轮询再也纠正不回来。
      if (!result.finished_at)
        continue
      pending.delete(result.client)
      outcomes.push(await applyRouteResult(candidate, result.result ?? '', options.trigger))
    }
  }

  for (const candidate of pending.values())
    outcomes.push({ uuid: candidate.uuid, name: candidate.name, status: 'timeout', detail: '节点未在时限内交回结果' })

  return { taskId: dispatch.task_id, outcomes }
}

async function applyRouteResult(
  candidate: RouteProbeCandidate,
  output: string,
  trigger: 'manual' | 'auto',
): Promise<RouteProbeOutcome> {
  if (!isUsableRouteTraceOutput(output)) {
    // 没装 traceroute 和命令没跑起来要分开报，前者运营者能自己修。
    const status = isMissingTracerouteOutput(output) ? 'no-traceroute' : 'failed'
    return {
      uuid: candidate.uuid,
      name: candidate.name,
      status,
      detail: status === 'no-traceroute' ? '节点未安装 traceroute' : '未取得可用的探测输出',
    }
  }

  const parsed = parseRouteTraceOutput(output)

  // 三家一个骨干跳都没认出来，更可能是这台机器的 traceroute 被拦或网络在抖，
  // 而不是回程真的变成了「未见骨干」。这种结果不写回：写了既会把上一次的好结果
  // 覆盖掉，又会让这台机器因为「标签还新鲜」而七天内不再重测。
  // 节点侧采集脚本有同样的守卫，两条路径的判断必须一致。
  if (Object.values(parsed).every(asns => !asns.length)) {
    return {
      uuid: candidate.uuid,
      name: candidate.name,
      status: 'failed',
      detail: '三家均未识别到骨干跳点，判为采集失败',
    }
  }

  const routeTag = formatNodeRouteTag(parsed, Date.now())
  const merged = mergeRouteTag(candidate.tags, routeTag)

  try {
    await getSharedRpc().editClient({ uuid: candidate.uuid, tags: merged })
    recordTopologyWrite({
      trigger,
      action: `写回回程线路 ${candidate.name}`,
      outcome: 'ok',
      detail: routeTag,
    })
    return { uuid: candidate.uuid, name: candidate.name, status: 'updated', detail: routeTag }
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    recordTopologyWrite({
      trigger,
      action: `写回回程线路 ${candidate.name}`,
      outcome: 'failed',
      detail,
    })
    return { uuid: candidate.uuid, name: candidate.name, status: 'failed', detail }
  }
}
