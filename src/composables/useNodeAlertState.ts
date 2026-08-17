import type { MaybeRefOrGetter } from 'vue'
import type { NodeAlert } from '@/utils/nodeAlert'
import { computed, shallowReactive, toValue } from 'vue'
import { recordAlertTransition } from '@/composables/useIncidentTimeline'
import { OPS_ALERT_STABILITY } from '@/constants/ops'

interface AlertTracker {
  initialized: boolean
  current: NodeAlert | null
  pending: NodeAlert | null
  pendingSamples: number
  recoverySamples: number
  sampleToken: string
}

const alertRegistry = shallowReactive(new Map<string, NodeAlert>())
const alertTrackers = new Map<string, AlertTracker>()

function requiredSamples(alert: NodeAlert): number {
  if (alert.key.endsWith(':offline') || alert.key.includes(':carrier:'))
    return 1
  return alert.severity === 'critical'
    ? OPS_ALERT_STABILITY.criticalSamples
    : OPS_ALERT_STABILITY.warningSamples
}

function publish(uuid: string, alert: NodeAlert | null): void {
  const previous = alertRegistry.get(uuid) ?? null
  if (alert)
    alertRegistry.set(uuid, alert)
  else
    alertRegistry.delete(uuid)
  recordAlertTransition(previous, alert)
}

export function reportNodeAlert(uuid: string, candidate: NodeAlert | null, sampleToken: string): void {
  if (!uuid || !sampleToken)
    return

  const tracker = alertTrackers.get(uuid) ?? {
    initialized: false,
    current: null,
    pending: null,
    pendingSamples: 0,
    recoverySamples: 0,
    sampleToken: '',
  }

  if (tracker.sampleToken === sampleToken)
    return
  tracker.sampleToken = sampleToken

  if (!tracker.initialized) {
    tracker.initialized = true
    tracker.current = candidate
    tracker.pending = null
    tracker.pendingSamples = 0
    tracker.recoverySamples = 0
    alertTrackers.set(uuid, tracker)
    publish(uuid, candidate)
    return
  }

  if (candidate && tracker.current?.key === candidate.key) {
    tracker.current = candidate
    tracker.pending = null
    tracker.pendingSamples = 0
    tracker.recoverySamples = 0
    alertTrackers.set(uuid, tracker)
    publish(uuid, candidate)
    return
  }

  if (!candidate) {
    tracker.pending = null
    tracker.pendingSamples = 0
    if (tracker.current) {
      tracker.recoverySamples += 1
      if (tracker.recoverySamples >= OPS_ALERT_STABILITY.recoverySamples) {
        tracker.current = null
        tracker.recoverySamples = 0
        publish(uuid, null)
      }
    }
    alertTrackers.set(uuid, tracker)
    return
  }

  tracker.recoverySamples = 0
  if (tracker.pending?.key === candidate.key) {
    tracker.pending = candidate
    tracker.pendingSamples += 1
  }
  else {
    tracker.pending = candidate
    tracker.pendingSamples = 1
  }

  if (tracker.pendingSamples >= requiredSamples(candidate)) {
    tracker.current = candidate
    tracker.pending = null
    tracker.pendingSamples = 0
    publish(uuid, candidate)
  }
  alertTrackers.set(uuid, tracker)
}

export function resetNodeAlert(uuid: string): void {
  alertTrackers.delete(uuid)
  alertRegistry.delete(uuid)
}

export function suppressNodeAlert(uuid: string): void {
  alertTrackers.delete(uuid)
  publish(uuid, null)
}

export function getNodeAlert(uuid: string): NodeAlert | null {
  return alertRegistry.get(uuid) ?? null
}

export function useNodeAlert(uuid: MaybeRefOrGetter<string>) {
  return computed(() => getNodeAlert(toValue(uuid)))
}
