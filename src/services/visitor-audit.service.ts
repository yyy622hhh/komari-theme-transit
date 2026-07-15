import type { VisitorAuditEventParams } from '@/utils/rpc'
import { requestManager } from '@/services/request.service'
import { getSharedRpc } from '@/utils/rpc'

export type VisitorAuditSubmitStatus = 'success' | 'disabled' | 'rate_limited' | 'failed'

const SESSION_STORAGE_KEY = 'komari-theme:visitor-audit-session'
const VISITOR_AUDIT_TIMEOUT_MS = 4_000
const DETAIL_JSON_LIMIT = 1_800
const SENSITIVE_KEY_PATTERN = /authorization|password|passwd|secret|token|clipboard|command|query_value|cookie_value|cookie_header/i
let requestSequence = 0
let memorySessionId = ''

function generateSessionId(): string {
  if (globalThis.crypto?.randomUUID)
    return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

export function getVisitorAuditSessionId(): string {
  if (memorySessionId)
    return memorySessionId

  try {
    memorySessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY) || generateSessionId()
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, memorySessionId)
  }
  catch {
    memorySessionId = generateSessionId()
  }
  return memorySessionId
}

function sanitizeDetailValue(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined)
    return undefined
  if (typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string')
    return value.slice(0, 256)
  if (Array.isArray(value)) {
    return value
      .slice(0, 24)
      .map(item => sanitizeDetailValue(item, depth + 1))
      .filter(item => item !== undefined)
  }
  if (typeof value !== 'object')
    return undefined

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (SENSITIVE_KEY_PATTERN.test(key))
      continue
    const sanitized = sanitizeDetailValue(item, depth + 1)
    if (sanitized !== undefined)
      result[key.slice(0, 64)] = sanitized
  }
  return result
}

function compactDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized = sanitizeDetailValue({
    ...detail,
    session_id: getVisitorAuditSessionId(),
  }) as Record<string, unknown> | undefined
  if (!sanitized)
    return { session_id: getVisitorAuditSessionId() }

  const encoded = JSON.stringify(sanitized)
  if (encoded.length <= DETAIL_JSON_LIMIT)
    return sanitized

  return {
    session_id: getVisitorAuditSessionId(),
    truncated: true,
    original_size: encoded.length,
    fingerprint_id: typeof sanitized.fingerprint_id === 'string' ? sanitized.fingerprint_id : undefined,
  }
}

function normalizeEvent(event: VisitorAuditEventParams): VisitorAuditEventParams | null {
  const eventName = event.event.trim().slice(0, 64)
  if (!eventName)
    return null

  return {
    event: eventName,
    path: event.path?.trim().slice(0, 512),
    route: event.route?.trim().slice(0, 128),
    target: event.target?.trim().slice(0, 128),
    detail: compactDetail(event.detail),
  }
}

export async function submitVisitorAuditEvent(event: VisitorAuditEventParams, enabled: boolean): Promise<VisitorAuditSubmitStatus> {
  if (!enabled || typeof window === 'undefined')
    return 'disabled'

  const normalized = normalizeEvent(event)
  if (!normalized)
    return 'failed'

  const requestKey = `visitor-audit:${getVisitorAuditSessionId()}:${++requestSequence}`
  try {
    const response = await requestManager.run(
      requestKey,
      signal => getSharedRpc().recordPublicVisitorEvent(normalized, signal),
      {
        timeout: VISITOR_AUDIT_TIMEOUT_MS,
        retryAttempts: 0,
        shouldRetry: () => false,
      },
    )
    if (response.status === 'success' || response.status === 'disabled' || response.status === 'rate_limited')
      return response.status
    return 'failed'
  }
  catch {
    return 'failed'
  }
}
