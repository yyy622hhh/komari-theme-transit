import { TIME_MS } from '@/constants/time'

export const OPS_ALERT_THRESHOLDS = {
  cpu: { warning: 85, critical: 95 },
  memory: { warning: 85, critical: 95 },
  disk: { warning: 80, critical: 92 },
  traffic: { warning: 85, critical: 95 },
  carrierLoss: { warning: 3, critical: 10 },
  carrierLatency: { warning: 200, critical: 260 },
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

export const OPS_PING_STALE_AFTER_MS = 2.5 * TIME_MS.minute

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
 * 第 2 段打的是操作者自己的落地机，443/80/22 上通常真有服务在听；入口打的是
 * 运营商公网测速点，那是骨干网关和 DNS 解析器，不会接 443/80/22。沿用第 2 段
 * 的阶梯只会白建三个任务、各等一个采样窗口再全部判死。DNS over TCP 是这类地址
 * 真正会应答的端口，所以 ICMP 之后只保留 TCP 53 这一档。
 */
export const OPS_TOPOLOGY_ENTRY_PROBE_LADDER = [
  { type: 'icmp' },
  { type: 'tcp', port: 53 },
] as const
