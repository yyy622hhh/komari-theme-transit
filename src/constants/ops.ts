import { TIME_MS } from '@/constants/time'

export const OPS_ALERT_THRESHOLDS = {
  cpu: { warning: 85, critical: 95 },
  memory: { warning: 85, critical: 95 },
  disk: { warning: 80, critical: 92 },
  traffic: { warning: 85, critical: 95 },
  carrierLoss: { warning: 3, critical: 10 },
  carrierLatency: { warning: 200, critical: 260 },
  carrierCommonMode: { minAffectedNodes: 5, minAffectedRatio: 0.6 },
} as const

export const OPS_ALERT_STABILITY = {
  warningSamples: 3,
  criticalSamples: 2,
  recoverySamples: 3,
} as const

export const OPS_ALERT_LIMITS = {
  desktop: 4,
  mobileCollapsed: 2,
} as const

/**
 * 回程线路判定的新鲜度。尺度是「天」而不是「分钟」：回程走哪条骨干网通常几周
 * 才变一次，采集端一天跑一次就够，所以过了一天还没更新只是提示，超过一周才当
 * 它失去参考价值。
 */
export const OPS_ROUTE_FRESHNESS = {
  /** 超过这个时间未更新时提示「可能不是最新」，判定结果继续显示。 */
  delayedAfterMs: TIME_MS.day,
  /** 超过这个时间未更新时判定结果不再可信，只保留采集时间。 */
  staleAfterMs: 7 * TIME_MS.day,
} as const

export const OPS_PING_FRESHNESS = {
  /** 超过这个时间仍未成功刷新时，只提示“可能不是最新”，继续显示最后数据。 */
  delayedAfterMs: 10 * TIME_MS.minute,
  /** 超过这个时间仍未成功刷新时，才判定不可用并切换到备用数据。 */
  staleAfterMs: 30 * TIME_MS.minute,
  /** 页面从后台恢复后留给立即刷新请求的宽限时间。 */
  resumeGraceMs: TIME_MS.minute,
} as const

/**
 * 拓扑第 2 段（线路机 → 落地机）自动挑选探测方式的参数。
 *
 * 主题会自己建任务、自己判断通不通、通不了自动换下一种方式，操作者不需要
 * 也不能在界面上选类型或端口。
 */
export const OPS_TOPOLOGY_HOP_PROBE = {
  /** 采样满这么多次仍然一次都没成功，就判定这种探测方式不通。 */
  deadSamples: 3,
  /** 判定健康度时回看的小时数。 */
  lookbackHours: 1,
  /** 拓扑管理对话框打开期间的复检间隔。 */
  recheckIntervalMs: TIME_MS.minute,
} as const

/** 第 2 段（线路机 → 落地机）探测方式阶梯：ICMP 不通就依次退到常见的 TCP 端口。 */
export const OPS_TOPOLOGY_HOP_PROBE_LADDER = [
  { type: 'icmp' },
  { type: 'tcp', port: 443 },
  { type: 'tcp', port: 80 },
  { type: 'tcp', port: 22 },
] as const

/**
 * 第 1 段（入口）专用阶梯，比第 2 段短。
 *
 * 第 2 段打的是操作者自己的落地机，443/80/22 上通常真有服务在听；入口使用的是
 * 内置候选地址，TCP 候选为运营商 DNS 解析器，不应盲试其他端口。候选是否对当前
 * 来源开放仍以实际采样为准，所以 ICMP 之后只保留 TCP 53 这一档。
 */
export const OPS_TOPOLOGY_ENTRY_PROBE_LADDER = [
  { type: 'icmp' },
  { type: 'tcp', port: 53 },
] as const

/** 自定义入口是操作者自己的 IP/域名，不假定它提供 DNS，沿用常见服务端口阶梯。 */
export const OPS_TOPOLOGY_CUSTOM_ENTRY_PROBE_LADDER = OPS_TOPOLOGY_HOP_PROBE_LADDER
