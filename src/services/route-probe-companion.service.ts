import type { RouteTraceCity } from '@/utils/routeTrace'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const COMPANION_ROOT = `${API_BASE.replace(/\/?api\/?$/, '')}/api/transit-route-probe/v1`
const BROWSER_GUARD_HEADER = { 'X-Transit-Route-Probe': '1' } as const

export type CompanionProbeStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface CompanionProbeJob {
  client: string
  city: RouteTraceCity
  status: CompanionProbeStatus
  tag: string | null
  error: 'no-traceroute' | 'probe-failed' | 'invalid-city' | 'internal-error' | null
  attempts: number
  helper_seen_at: number | null
}

export interface CompanionProbeBatch {
  batch_id: string
  jobs: CompanionProbeJob[]
}

export class RouteProbeCompanionUnavailableError extends Error {
  constructor() {
    super('Transit Route Probe 伴生插件未安装或未启用')
    this.name = 'RouteProbeCompanionUnavailableError'
  }
}

export class RouteProbeCompanionError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RouteProbeCompanionError'
    this.status = status
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isCompanionJob(value: unknown): value is CompanionProbeJob {
  if (!isRecord(value))
    return false
  return typeof value.client === 'string'
    && (value.city === 'beijing' || value.city === 'shanghai' || value.city === 'guangzhou')
    && (value.status === 'queued' || value.status === 'running' || value.status === 'completed' || value.status === 'failed')
    && (value.tag === null || typeof value.tag === 'string')
    && (value.error === null || value.error === 'no-traceroute' || value.error === 'probe-failed'
      || value.error === 'invalid-city' || value.error === 'internal-error')
    && typeof value.attempts === 'number'
    && (value.helper_seen_at === null || typeof value.helper_seen_at === 'number')
}

function parseBatch(value: unknown): CompanionProbeBatch {
  if (!isRecord(value) || typeof value.batch_id !== 'string' || !Array.isArray(value.jobs)
    || !value.jobs.every(isCompanionJob)) {
    throw new RouteProbeCompanionError(502, '伴生插件返回了无效的数据结构')
  }
  return value as unknown as CompanionProbeBatch
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json()
  }
  catch {
    return null
  }
}

async function requestBatch(url: string, init: RequestInit): Promise<CompanionProbeBatch> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...BROWSER_GUARD_HEADER,
      ...init.headers,
    },
  })
  if (response.status === 404)
    throw new RouteProbeCompanionUnavailableError()

  const payload = await readPayload(response)
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `伴生插件请求失败（HTTP ${response.status}）`
    throw new RouteProbeCompanionError(response.status, message)
  }
  return parseBatch(payload)
}

export function enqueueCompanionRouteProbe(
  clients: readonly string[],
  city: RouteTraceCity,
  signal?: AbortSignal,
): Promise<CompanionProbeBatch> {
  return requestBatch(`${COMPANION_ROOT}/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clients, city }),
    signal,
  })
}

export function getCompanionRouteProbeBatch(
  batchId: string,
  signal?: AbortSignal,
): Promise<CompanionProbeBatch> {
  const query = new URLSearchParams({ batch_id: batchId })
  return requestBatch(`${COMPANION_ROOT}/status?${query}`, {
    method: 'GET',
    signal,
  })
}
