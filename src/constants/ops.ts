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

/** 探测方式阶梯：ICMP 不通就依次退到常见的 TCP 端口。 */
export const OPS_TOPOLOGY_HOP_PROBE_LADDER = [
  { type: 'icmp' },
  { type: 'tcp', port: 443 },
  { type: 'tcp', port: 80 },
  { type: 'tcp', port: 22 },
] as const
