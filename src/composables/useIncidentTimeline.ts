import type { NodeAlert } from '@/utils/nodeAlert'
import { computed, shallowRef } from 'vue'

export type IncidentEventType
  = | 'started'
    | 'recovered'
    | 'silenced'
    | 'silenceEnded'
    | 'maintenanceStarted'
    | 'maintenanceEnded'

export interface IncidentEvent {
  id: string
  nodeUuid: string
  nodeName: string
  type: IncidentEventType
  alertKey?: string
  detail: string
  severity?: NodeAlert['severity']
  timestamp: number
  durationMs?: number
}

const STORAGE_KEY = 'pandaOpsIncidentTimelineV1'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_EVENTS = 200
const events = shallowRef<IncidentEvent[]>([])
let initialized = false

function initialize(): void {
  if (initialized || typeof window === 'undefined')
    return
  initialized = true
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as unknown
    if (Array.isArray(parsed)) {
      const cutoff = Date.now() - RETENTION_MS
      events.value = parsed
        .filter((item): item is IncidentEvent => Boolean(item && typeof item === 'object' && typeof (item as IncidentEvent).timestamp === 'number'))
        .filter(item => item.timestamp >= cutoff)
        .slice(0, MAX_EVENTS)
    }
  }
  catch {
    events.value = []
  }
}

function persist(): void {
  if (typeof window === 'undefined')
    return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events.value))
  }
  catch {
    // 浏览器禁用本地存储时仅保留当前会话。
  }
}

function addEvent(event: Omit<IncidentEvent, 'id' | 'timestamp'> & { timestamp?: number }): void {
  initialize()
  const timestamp = event.timestamp ?? Date.now()
  const cutoff = timestamp - RETENTION_MS
  events.value = [{
    ...event,
    id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
  }, ...events.value.filter(item => item.timestamp >= cutoff)].slice(0, MAX_EVENTS)
  persist()
}

function latestAlertEvent(alertKey: string): IncidentEvent | undefined {
  initialize()
  return events.value.find(item => item.alertKey === alertKey && (item.type === 'started' || item.type === 'recovered'))
}

export function recordAlertTransition(previous: NodeAlert | null, next: NodeAlert | null): void {
  initialize()
  if (previous?.key === next?.key)
    return

  if (previous) {
    const latest = latestAlertEvent(previous.key)
    if (latest?.type === 'started') {
      addEvent({
        nodeUuid: previous.nodeUuid,
        nodeName: previous.nodeName,
        type: 'recovered',
        alertKey: previous.key,
        detail: `${previous.detail} 已恢复`,
        severity: previous.severity,
        durationMs: Math.max(0, Date.now() - latest.timestamp),
      })
    }
  }

  if (next) {
    const latest = latestAlertEvent(next.key)
    if (latest?.type !== 'started') {
      addEvent({
        nodeUuid: next.nodeUuid,
        nodeName: next.nodeName,
        type: 'started',
        alertKey: next.key,
        detail: next.detail,
        severity: next.severity,
      })
    }
  }
}

export function recordControlEvent(
  nodeUuid: string,
  nodeName: string,
  type: Extract<IncidentEventType, 'silenced' | 'silenceEnded' | 'maintenanceStarted' | 'maintenanceEnded'>,
  detail: string,
): void {
  addEvent({ nodeUuid, nodeName, type, detail })
}

export function useIncidentTimeline() {
  initialize()
  return {
    events: computed(() => events.value),
    todayEvents: computed(() => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      return events.value.filter(item => item.timestamp >= start)
    }),
  }
}
