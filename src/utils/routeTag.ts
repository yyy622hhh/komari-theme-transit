/**
 * 回程判定结果的兼容传输格式。
 *
 * 主题不能自己跑 traceroute（浏览器没有原始套接字，Komari 的 Ping 任务也只有
 * icmp/tcp/http），采集必须在节点上完成。这里定义节点助手交回结果时使用的格式。
 * 当前主题把它存入 `pandaOpsRouteProbeResults`；早期版本和独立采集脚本曾把它写进
 * 节点 `tags`，所以解析与迁移仍需长期兼容这一格式。
 *
 * ```text
 * transit-route:ct=4809.4809.4134,cu=4837.4837,cm=58807.9808@1755000000
 * ```
 *
 * - `ct` / `cu` / `cm`：电信 / 联通 / 移动，缺省表示这次没探这家。
 * - 等号后面是**按跳序排列的骨干网 ASN**，只留认得出的跳。认不出的跳可以直接
 *   丢掉：判定只看几个目标 ASN 的先后与出现次数，中间隔了几跳不影响结论。
 * - `ct=` 这种空值表示探了但一个骨干跳都没认出来，和「没探」是两回事。
 * - `@` 后面是采集时刻的 Unix 秒。
 *
 * `parseTags` 仍会过滤遗留条目，避免迁移完成前在 Transit 自己的标签区域重复显示。
 */

import type { RouteCarrier, RouteClassification } from '@/utils/routeClassification'
import { OPS_ROUTE_FRESHNESS } from '@/constants/ops'
import { classifyReturnRoute } from '@/utils/routeClassification'

/** 保留前缀。大小写不敏感，比对前统一转小写。 */
export const NODE_ROUTE_TAG_PREFIX = 'transit-route:'

export type RouteFreshness = 'unknown' | 'fresh' | 'delayed' | 'stale'

export interface NodeRouteEntry {
  carrier: RouteCarrier
  /** 运营商中文名，用于界面。 */
  carrierLabel: string
  /** 按跳序排列的骨干网 ASN，形如 `AS4809`。 */
  asns: string[]
  classification: RouteClassification
}

export interface NodeRouteReport {
  entries: NodeRouteEntry[]
  /** 采集时刻，毫秒；标签没带时间戳时为 `null`。 */
  measuredAt: number | null
  freshness: RouteFreshness
  /** 原始标签，排障时用来确认主题读到的到底是什么。 */
  raw: string
}

const CARRIER_LABELS: Readonly<Record<RouteCarrier, string>> = Object.freeze({
  CT: '电信',
  CU: '联通',
  CM: '移动',
})

const CARRIER_KEYS: Readonly<Record<string, RouteCarrier>> = Object.freeze({
  ct: 'CT',
  cu: 'CU',
  cm: 'CM',
})

const ASN_NUMBER_PATTERN = /^\d{1,10}$/

export function isNodeRouteTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(NODE_ROUTE_TAG_PREFIX)
}

function parseAsnList(value: string): string[] {
  return value
    .split('.')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => ASN_NUMBER_PATTERN.test(part))
    .map(part => `AS${Number(part)}`)
}

function resolveFreshness(measuredAt: number | null, now: number): RouteFreshness {
  if (measuredAt === null)
    return 'unknown'
  const age = Math.max(0, now - measuredAt)
  if (age >= OPS_ROUTE_FRESHNESS.staleAfterMs)
    return 'stale'
  if (age >= OPS_ROUTE_FRESHNESS.delayedAfterMs)
    return 'delayed'
  return 'fresh'
}

/**
 * 从单条结果或节点的遗留 `tags` 字段里取出回程判定结果。
 *
 * 没有保留标签、标签写坏了、或者一个运营商都没解析出来时返回 `null`——采集端
 * 没配好不应该在界面上留下半截空壳。
 */
export function parseNodeRouteTag(tags: string | undefined | null, now = Date.now()): NodeRouteReport | null {
  if (!tags)
    return null

  const raw = tags
    .split(';')
    .map(tag => tag.trim())
    .find(isNodeRouteTag)
  if (!raw)
    return null

  let body = raw.slice(NODE_ROUTE_TAG_PREFIX.length).trim()
  let measuredAt: number | null = null

  const stampIndex = body.lastIndexOf('@')
  if (stampIndex >= 0) {
    const stamp = Number(body.slice(stampIndex + 1).trim())
    body = body.slice(0, stampIndex)
    // 秒级时间戳；不是有效数字就当没带，而不是把整条标签判废。
    if (Number.isInteger(stamp) && stamp > 0)
      measuredAt = stamp * 1000
  }

  const entries: NodeRouteEntry[] = []
  for (const segment of body.split(',')) {
    const separator = segment.indexOf('=')
    if (separator < 0)
      continue
    const carrier = CARRIER_KEYS[segment.slice(0, separator).trim().toLowerCase()]
    if (!carrier || entries.some(entry => entry.carrier === carrier))
      continue
    const asns = parseAsnList(segment.slice(separator + 1))
    entries.push({
      carrier,
      carrierLabel: CARRIER_LABELS[carrier],
      asns,
      classification: classifyReturnRoute(carrier, asns.map((asn, index) => ({
        distance: index + 1,
        asns: [asn],
      }))),
    })
  }

  if (!entries.length)
    return null

  // 固定按电信/联通/移动排列，不跟着标签里的书写顺序走。
  const order: RouteCarrier[] = ['CT', 'CU', 'CM']
  entries.sort((first, second) => order.indexOf(first.carrier) - order.indexOf(second.carrier))

  return { entries, measuredAt, freshness: resolveFreshness(measuredAt, now), raw }
}

/**
 * 反向拼出标签内容，供文档示例和采集脚本的自检使用。
 * `asns` 传形如 `AS4809` 或 `4809` 都可以。
 */
export function formatNodeRouteTag(
  input: Partial<Record<RouteCarrier, readonly string[]>>,
  measuredAt: number | null = null,
): string {
  const body = (['CT', 'CU', 'CM'] as RouteCarrier[])
    .filter(carrier => input[carrier] !== undefined)
    .map(carrier => `${carrier.toLowerCase()}=${(input[carrier] ?? [])
      .map(asn => asn.trim().replace(/^as/i, ''))
      .filter(asn => ASN_NUMBER_PATTERN.test(asn))
      .join('.')}`)
    .join(',')
  const stamp = measuredAt === null ? '' : `@${Math.floor(measuredAt / 1000)}`
  return `${NODE_ROUTE_TAG_PREFIX}${body}${stamp}`
}
