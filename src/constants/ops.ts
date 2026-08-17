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
