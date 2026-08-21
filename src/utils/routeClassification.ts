/**
 * 三网回程线路判定：把一条 traceroute 的逐跳 ASN 证据判成 CN2GIA / 163 / 9929
 * / CMIN2 这类线路名。
 *
 * 判定规则移植自 oneclickvirt/backtrace 的 `bk/route_classification.go` 与
 * `bk/ipv4_asn.go`（NodeQuality 的三网回程检测最终调用的就是这一套）。`code`
 * 与上游保持逐字一致，好让两边的结论可以直接对照。
 *
 * ## 方向
 *
 * 「回程」是相对国内用户定义的：国内用户 → 节点是去程，节点 → 国内用户是回程。
 * 所以证据必须来自**节点主动向国内三网测速点发起的 traceroute**，方向和
 * `topologyPresets.ts` 里那九个入口预设完全一致（目标 IP 也是同一份表）。
 *
 * ## 本文件不做什么
 *
 * 不采集。浏览器没有原始套接字，traceroute 只能在节点上跑完再把结果送进来。
 * 这里只负责「给定跳点，判成哪条线」这一段纯计算。
 */

/** 运营商代号。上游用 CT/CU/CM，这里保持一致。 */
export type RouteCarrier = 'CT' | 'CU' | 'CM'

/**
 * 判定的把握程度。
 *
 * - `confirmed`：骨干网证据充分。
 * - `mixed`：证据互相矛盾，或只够说明「沾到了这条线」而不足以定级。
 * - `inconclusive`：证据不足，不给线路名。
 */
export type RouteConfidence = 'confirmed' | 'mixed' | 'inconclusive'

/** 线路档次。证据不足时为 `null`，不硬凑。 */
export type RouteGrade = '精品线路' | '优质线路' | '普通线路' | null

/** 一跳的 ASN 证据。同一跳可能有多个 ASN——多次 traceroute 走了不同路径。 */
export interface RouteHopEvidence {
  /** 跳数，从 1 开始。 */
  distance: number
  asns: string[]
}

export interface RouteClassification {
  /** 与 backtrace 逐字一致的机器可读值，例如 `ct_cn2_gia`。 */
  code: string
  /** 线路名，例如「电信CN2GIA」。证据不足时是说明文字。 */
  label: string
  grade: RouteGrade
  confidence: RouteConfidence
  /** 线路优劣排序，0 表示未判定；仅用于多次探测结果取优。 */
  rank: number
  /** 判定依据，英文技术描述，原样保留上游文案以便对照。 */
  evidence: string
}

/** 骨干网 ASN 的中文名，供界面展示逐跳证据时使用。 */
export const ROUTE_ASN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AS4809: '电信 CN2',
  AS4134: '电信 163',
  AS23764: '电信 CTGNET',
  AS9929: '联通 9929',
  AS10099: '联通 CUG',
  AS4837: '联通 169',
  AS58807: '移动 CMIN2',
  AS58453: '移动 CMI',
  AS9808: '移动 CMNET',
})

/**
 * 骨干网 IPv4 段。
 *
 * 上游用 `strings.HasPrefix(ip, "111.24")` 这种裸字符串前缀匹配，会连带命中
 * `111.240.*` ~ `111.249.*`——那是另一个 /8 里的地址。`61.14`（会误命中
 * `61.140.*`，实为电信广东）和 `203.22` 同样有这个问题。这里改成按点分段比对，
 * 只认整段相等，是有意偏离上游的一处修正。
 */
const ROUTE_ASN_PREFIXES: ReadonlyArray<readonly [readonly number[], string]> = Object.freeze([
  [[59, 43], 'AS4809'],
  [[202, 97], 'AS4134'],
  [[218, 105], 'AS9929'],
  [[210, 51], 'AS9929'],
  [[202, 77], 'AS10099'],
  [[43, 252], 'AS10099'],
  [[61, 14], 'AS10099'],
  [[219, 158], 'AS4837'],
  [[223, 118], 'AS58453'],
  [[223, 119], 'AS58453'],
  [[223, 120], 'AS58453'],
  [[223, 121], 'AS58453'],
  [[221, 183], 'AS9808'],
  [[111, 24], 'AS9808'],
  [[69, 194], 'AS23764'],
  [[203, 22], 'AS23764'],
])

const IPV4_OCTET_PATTERN = /^\d{1,3}$/

function parseIpv4Octets(value: string): number[] | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4)
    return null
  const octets: number[] = []
  for (const part of parts) {
    if (!IPV4_OCTET_PATTERN.test(part))
      return null
    const octet = Number(part)
    if (octet > 255)
      return null
    octets.push(octet)
  }
  return octets
}

/**
 * 移动 CMIN2（AS58807）在 223/8 里和 CMI（AS58453）交错，只能按第三段细分。
 * 段落取自上游 `isCMIN2IPv4`。
 */
function isCmin2Ipv4(octets: readonly number[]): boolean {
  const [first, second, third] = octets as [number, number, number, number]
  if (first !== 223)
    return false
  if (second === 118 && third === 32)
    return true
  if (second === 120 && third >= 128)
    return true
  if (second !== 119)
    return false
  return third === 8 || third === 9
    || (third >= 10 && third <= 15)
    || (third >= 26 && third <= 29)
    || (third >= 32 && third <= 37)
    || third === 74 || third === 75 || third === 88 || third === 89
    || third === 100 || third === 252 || third === 253
}

/**
 * 把一个跳点 IPv4 地址映射成骨干网 ASN，认不出返回空串。
 *
 * IPv6 不支持：上游靠内嵌约 167 KB 的前缀表做最长匹配，塞进主题产物不划算。
 * 采集端（nt3 / backtrace）本来就能直接给出 ASN，优先走那条路。
 */
export function resolveHopAsn(ip: string): string {
  const octets = parseIpv4Octets(ip)
  if (!octets)
    return ''
  // CMIN2 必须先判：它的地址段落在 CMI 的 223.118/223.120 前缀里面。
  if (isCmin2Ipv4(octets))
    return 'AS58807'
  for (const [prefix, asn] of ROUTE_ASN_PREFIXES) {
    if (prefix.every((value, index) => octets[index] === value))
      return asn
  }
  return ''
}

/**
 * 把有序的跳点地址转成判定输入。认不出 ASN 的跳保留位置但不带证据——跳数
 * 本身参与判定，丢掉会改变 ASN 的先后关系。
 */
export function buildRouteHopEvidence(hops: readonly (string | readonly string[])[]): RouteHopEvidence[] {
  return hops.map((hop, index) => {
    const addresses = typeof hop === 'string' ? [hop] : hop
    const asns = [...new Set(addresses.map(resolveHopAsn).filter(Boolean))]
    return { distance: index + 1, asns }
  })
}

export function normalizeRouteCarrier(value: string): string {
  const normalized = value.trim().toUpperCase()
  switch (normalized) {
    case 'CT':
    case 'TELECOM':
    case '电信':
      return 'CT'
    case 'CU':
    case 'UNICOM':
    case '联通':
      return 'CU'
    case 'CM':
    case 'CMCC':
    case 'MOBILE':
    case '移动':
      return 'CM'
    default:
      return normalized
  }
}

function inconclusive(code: string, label: string, evidence: string): RouteClassification {
  return { code, label, grade: null, confidence: 'inconclusive', rank: 0, evidence }
}

/**
 * 找出某个 ASN 第一次出现的跳序，以及它一共出现在几跳上。
 * 返回 `[-1, 0]` 表示没出现过。
 */
function routeAsnPosition(hops: readonly RouteHopEvidence[], target: string): [number, number] {
  let first = -1
  let count = 0
  hops.forEach((hop, index) => {
    const matched = hop.asns.some(asn => asn.trim().toUpperCase() === target)
    if (!matched)
      return
    if (first < 0)
      first = index
    count += 1
  })
  return [first, count]
}

/**
 * 电信：CN2（AS4809）要出现至少两跳才敢报 GIA。只有一跳说明流量只是擦过
 * CN2，或者那一跳其实是落地网关，不足以和 GT 区分。
 */
function classifyTelecom(hops: readonly RouteHopEvidence[]): RouteClassification {
  const [cn2Index, cn2Hops] = routeAsnPosition(hops, 'AS4809')
  const [ct163Index, ct163Hops] = routeAsnPosition(hops, 'AS4134')
  const [ctgIndex] = routeAsnPosition(hops, 'AS23764')

  if (cn2Index >= 0) {
    if (cn2Hops < 2) {
      return {
        code: 'ct_cn2_mixed',
        label: '电信CN2混合',
        grade: '优质线路',
        confidence: 'mixed',
        rank: 3,
        evidence: 'only one AS4809 hop; CN2 GIA is not confirmed',
      }
    }
    if (ct163Index < 0 || (cn2Index < ct163Index && ct163Hops <= 1)) {
      return {
        code: 'ct_cn2_gia',
        label: '电信CN2GIA',
        grade: '精品线路',
        confidence: 'confirmed',
        rank: 5,
        evidence: 'at least two AS4809 hops precede at most one AS4134 delivery hop',
      }
    }
    if (cn2Index < ct163Index) {
      return {
        code: 'ct_cn2_mixed',
        label: '电信CN2混合',
        grade: '优质线路',
        confidence: 'mixed',
        rank: 3,
        evidence: 'AS4809 is followed by multiple AS4134 backbone hops',
      }
    }
    return {
      code: 'ct_cn2_gt',
      label: '电信CN2GT',
      grade: '优质线路',
      confidence: 'mixed',
      rank: 3,
      evidence: 'AS4134 appears before the AS4809 segment',
    }
  }

  if (ctgIndex >= 0) {
    return {
      code: 'ct_ctgnet',
      label: '电信CTGNET',
      grade: '精品线路',
      confidence: 'confirmed',
      rank: 4,
      evidence: 'AS23764 is present',
    }
  }

  if (ct163Index >= 0) {
    // 单独一跳 AS4134 更可能是目的网交付跳，不能据此判 163 骨干。
    if (ct163Hops <= 1)
      return inconclusive('ct_destination_only', '仅见电信目的网', 'only one AS4134 hop')
    return {
      code: 'ct_163',
      label: '电信163',
      grade: '普通线路',
      confidence: 'confirmed',
      rank: 2,
      evidence: 'multiple AS4134 hops are present without premium backbone evidence',
    }
  }

  return inconclusive('ct_unknown', '未见电信骨干', 'AS4809, AS23764, and AS4134 are absent')
}

/** 联通：9929 在 4837 之后出现说明前半程还是走的普通网，只能算混合。 */
function classifyUnicom(hops: readonly RouteHopEvidence[]): RouteClassification {
  const [cu9929Index] = routeAsnPosition(hops, 'AS9929')
  const [cugIndex] = routeAsnPosition(hops, 'AS10099')
  const [cu4837Index, cu4837Hops] = routeAsnPosition(hops, 'AS4837')

  if (cu9929Index >= 0) {
    if (cu4837Index >= 0 && cu4837Index < cu9929Index) {
      return {
        code: 'cu_9929_mixed',
        label: '联通9929混合',
        grade: '优质线路',
        confidence: 'mixed',
        rank: 3,
        evidence: 'AS4837 appears before the AS9929 segment',
      }
    }
    return {
      code: 'cu_9929',
      label: '联通9929',
      grade: '优质线路',
      confidence: 'confirmed',
      rank: 5,
      evidence: 'AS9929 is present without an earlier AS4837 segment',
    }
  }

  if (cugIndex >= 0) {
    return {
      code: 'cu_cug',
      label: '联通CUG',
      grade: '优质线路',
      confidence: 'confirmed',
      rank: 3,
      evidence: 'AS10099 is present without AS9929',
    }
  }

  if (cu4837Index >= 0) {
    if (cu4837Hops <= 1)
      return inconclusive('cu_destination_only', '仅见联通目的网', 'only one AS4837 hop')
    return {
      code: 'cu_4837',
      label: '联通4837',
      grade: '普通线路',
      confidence: 'confirmed',
      rank: 2,
      evidence: 'multiple AS4837 hops are present without premium backbone evidence',
    }
  }

  return inconclusive('cu_unknown', '未见联通骨干', 'AS9929, AS10099, and AS4837 are absent')
}

/** 移动：CMIN2（AS58807）排在 CMI（AS58453）之后同样降级为混合。 */
function classifyMobile(hops: readonly RouteHopEvidence[]): RouteClassification {
  const [cmin2Index] = routeAsnPosition(hops, 'AS58807')
  const [cmiIndex] = routeAsnPosition(hops, 'AS58453')
  const [cmnetIndex] = routeAsnPosition(hops, 'AS9808')

  if (cmin2Index >= 0) {
    if (cmiIndex >= 0 && cmiIndex < cmin2Index) {
      return {
        code: 'cm_cmin2_mixed',
        label: '移动CMIN2混合',
        grade: '优质线路',
        confidence: 'mixed',
        rank: 3,
        evidence: 'AS58453 appears before the AS58807 segment',
      }
    }
    return {
      code: 'cm_cmin2',
      label: '移动CMIN2',
      grade: '精品线路',
      confidence: 'confirmed',
      rank: 5,
      evidence: 'AS58807 is present without an earlier AS58453 segment',
    }
  }

  if (cmiIndex >= 0) {
    return {
      code: 'cm_cmi',
      label: '移动CMI',
      grade: '普通线路',
      confidence: 'confirmed',
      rank: 2,
      evidence: 'AS58453 is present without CMIN2 evidence',
    }
  }

  if (cmnetIndex >= 0) {
    return {
      code: 'cm_cmnet',
      label: '移动CMNET',
      grade: '普通线路',
      confidence: 'confirmed',
      rank: 2,
      evidence: 'AS9808 is present without international premium backbone evidence',
    }
  }

  return inconclusive('cm_unknown', '未见移动骨干', 'AS58807, AS58453, and AS9808 are absent')
}

/** 判定一条回程线路。`hops` 必须按跳序排列——先后关系直接决定结论。 */
export function classifyReturnRoute(carrier: string, hops: readonly RouteHopEvidence[]): RouteClassification {
  switch (normalizeRouteCarrier(carrier)) {
    case 'CT':
      return classifyTelecom(hops)
    case 'CU':
      return classifyUnicom(hops)
    case 'CM':
      return classifyMobile(hops)
    default:
      return inconclusive('unknown_carrier', '线路证据不足', 'unknown carrier')
  }
}

const DYNAMIC_MIXED_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CT: '电信动态混合',
  CU: '联通动态混合',
  CM: '移动动态混合',
})

/**
 * 合并同一条线路的多次探测结论。
 *
 * 有结论的优先于「证据不足」；多次都有结论但互相打架时，说明这条线在做动态
 * 调度，降级成「动态混合」而不是挑一个最好的报上去。
 */
export function combineRouteClassifications(
  carrier: string,
  values: readonly RouteClassification[],
): RouteClassification {
  const normalized = normalizeRouteCarrier(carrier)
  const known = values.filter(value => value.confidence !== 'inconclusive')

  if (!known.length) {
    if (values.length)
      return values[0]!
    return inconclusive(`${normalized.toLowerCase()}_unknown`, '线路证据不足', 'no classified route evidence')
  }

  let best = known[0]!
  const distinct = new Set([best.code])
  for (const value of known.slice(1)) {
    distinct.add(value.code)
    if (value.rank > best.rank)
      best = value
  }
  if (distinct.size === 1)
    return best

  return {
    code: `${normalized.toLowerCase()}_dynamic_mixed`,
    label: DYNAMIC_MIXED_LABELS[normalized] ?? '动态混合线路',
    grade: '优质线路',
    confidence: 'mixed',
    rank: 3,
    evidence: 'successful trace attempts observed conflicting backbone classes',
  }
}
