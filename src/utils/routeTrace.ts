/**
 * 回程采集命令的生成与输出解析。
 *
 * 主题通过 Komari 的 `admin:exec` 把这条命令下发给节点，节点跑完把 stdout 交回
 * 来，这里再解析成逐跳 ASN 交给 `routeClassification.ts` 判线。
 *
 * ## 命令为什么写成一长串平铺的形式
 *
 * 这条命令会以 root 身份在运营者的每一台服务器上执行，所以它必须是**编译期常量**：
 * 目标地址来自 `topologyPresets.ts` 的预设表，节点 UUID 只进 `admin:exec` 的
 * `clients` 数组、绝不进命令字符串。没有任何运行时拼接，也就没有注入面。
 *
 * 为此宁可把三家运营商展开成重复的三段，也不用 shell 变量和循环——变量展开一旦
 * 引入，"命令里没有外部输入"这句话就要靠读代码去证明，而不是一眼可见。
 */

import type { RouteCarrier } from '@/utils/routeClassification'
import { normalizeRouteCarrier, resolveHopAsn } from '@/utils/routeClassification'
import { TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'

/** 采集用的城市。与三网质量那一行的地区设置同名，便于对齐。 */
export type RouteTraceCity = 'beijing' | 'shanghai' | 'guangzhou'

/** 每家运营商在输出里的分段标记。取得足够怪，不会和 traceroute 自己的输出撞。 */
const SECTION_MARKERS: Readonly<Record<RouteCarrier, string>> = Object.freeze({
  CT: '__TRANSIT_ROUTE_CT__',
  CU: '__TRANSIT_ROUTE_CU__',
  CM: '__TRANSIT_ROUTE_CM__',
})

/** 最大跳数。超过 30 跳的部分对判线没有意义，只会拖长执行时间。 */
const MAX_HOPS = 30

/** 节点上没装 traceroute 时的回执标记。命令和解析共用同一份，不再各写一遍字面量。 */
export const ROUTE_TRACE_MISSING_MARKER = '__TRANSIT_ROUTE_NO_TRACEROUTE__'

/**
 * 取某城市三家运营商的骨干网关地址。
 * 直接复用入口预设表，避免地址在两处各写一份而漂移。
 */
export function routeTraceTargets(city: RouteTraceCity): Record<RouteCarrier, string> {
  const targets = {} as Record<RouteCarrier, string>
  for (const option of TOPOLOGY_PROBE_OPTIONS) {
    if (!option.key.startsWith(`${city}-`))
      continue
    const carrier = normalizeRouteCarrier(option.carrier) as RouteCarrier
    if (carrier === 'CT' || carrier === 'CU' || carrier === 'CM')
      targets[carrier] = option.landmarkAddress
  }
  return targets
}

/**
 * ICMP 优先、UDP 兜底。国内测速点普遍过滤 UDP 探测包，但 ICMP 模式要 root；
 * 两种都试一次，哪种出数用哪种。`command -v` 先探一下，省得没装 traceroute 的
 * 机器刷一屏 not found。
 */
function traceSegment(carrier: RouteCarrier, target: string): string {
  return [
    `echo ${SECTION_MARKERS[carrier]}`,
    `traceroute -I -n -q 1 -w 1 -m ${MAX_HOPS} ${target} 2>/dev/null`
    + ` || traceroute -n -q 1 -w 1 -m ${MAX_HOPS} ${target} 2>/dev/null`
    + ` || true`,
  ].join('; ')
}

/**
 * 生成下发给节点的命令。返回的字符串里只有预设表中的常量地址，没有任何来自
 * 节点、用户或主题设置的值。
 */
export function buildRouteTraceCommand(city: RouteTraceCity): string {
  const targets = routeTraceTargets(city)
  const carriers: RouteCarrier[] = ['CT', 'CU', 'CM']
  const segments = carriers
    .filter(carrier => targets[carrier])
    .map(carrier => traceSegment(carrier, targets[carrier]!))
  if (!segments.length)
    return ''
  // 没有 traceroute 就直接给一句能认出来的话，免得回来一堆 shell 报错要猜。
  return `command -v traceroute >/dev/null 2>&1 || { echo ${ROUTE_TRACE_MISSING_MARKER}; exit 0; }; ${segments.join('; ')}`
}

/** 判断一次回执是不是「节点没装 traceroute」，而不是别的失败。 */
export function isMissingTracerouteOutput(output: string): boolean {
  return output.includes(ROUTE_TRACE_MISSING_MARKER)
}

// traceroute 的一行长这样：`  5  59.43.130.1  1.234 ms`。取跳号后面那个地址。
const HOP_LINE_PATTERN = /^\s*\d+\s+((?:\d{1,3}\.){3}\d{1,3})\b/

/**
 * 解析命令输出，得到每家运营商按跳序排列的骨干网 ASN。
 *
 * 认不出 ASN 的跳直接丢掉：判线只看目标 ASN 的先后顺序和出现次数，中间隔了几跳
 * 不影响结论（`routeClassification.ts` 的比较全部是相对位置）。
 *
 * 返回值里「键存在但数组为空」表示这家探了但没认出骨干跳，和「键不存在」（没探）
 * 是两种不同的情况，`formatNodeRouteTag` 会把它们编码成不同的标签。
 */
export function parseRouteTraceOutput(output: string): Partial<Record<RouteCarrier, string[]>> {
  if (!output || isMissingTracerouteOutput(output))
    return {}

  const result: Partial<Record<RouteCarrier, string[]>> = {}
  let current: RouteCarrier | null = null

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()

    const marker = (Object.keys(SECTION_MARKERS) as RouteCarrier[])
      .find(carrier => line === SECTION_MARKERS[carrier])
    if (marker) {
      current = marker
      result[marker] = []
      continue
    }
    if (!current)
      continue

    const matched = HOP_LINE_PATTERN.exec(rawLine)
    if (!matched)
      continue
    const asn = resolveHopAsn(matched[1]!)
    if (asn)
      result[current]!.push(asn)
  }

  return result
}

/** 输出里连一个分段标记都没有，说明命令根本没跑起来，不该据此写标签。 */
export function isUsableRouteTraceOutput(output: string): boolean {
  return Object.keys(parseRouteTraceOutput(output)).length > 0
}
