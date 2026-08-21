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

/**
 * 三个伴生插件接口共用的请求外壳：404 统一映射成「未安装」，非 2xx 统一映射
 * 成携带服务端消息的错误。`parse` 只管把已经确认是 2xx 的 payload 转成具体
 * 形状，形状不对就自己抛 `RouteProbeCompanionError`。
 */
async function requestCompanion<T>(
  url: string,
  init: RequestInit,
  parse: (payload: unknown) => T,
): Promise<T> {
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
  return parse(payload)
}

function requestBatch(url: string, init: RequestInit): Promise<CompanionProbeBatch> {
  return requestCompanion(url, init, parseBatch)
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

export interface CompanionHealth {
  ok: boolean
  protocol: number
  version: string | null
}

function isCompanionHealth(value: unknown): value is CompanionHealth {
  return isRecord(value) && value.ok === true && typeof value.protocol === 'number'
}

/**
 * 设置向导用来判断伴生插件是否已安装。404 说明插件未安装或未启用，交由调用方
 * 捕获 `RouteProbeCompanionUnavailableError` 处理；这里不吞掉，语义和其余请求
 * 保持一致。
 */
export function getCompanionRouteProbeHealth(signal?: AbortSignal): Promise<CompanionHealth> {
  return requestCompanion(`${COMPANION_ROOT}/health`, { method: 'GET', signal }, (payload) => {
    if (!isCompanionHealth(payload))
      throw new RouteProbeCompanionError(502, '伴生插件返回了无效的健康检查数据')
    return { ok: payload.ok, protocol: payload.protocol, version: typeof payload.version === 'string' ? payload.version : null }
  })
}

export interface CompanionRosterEntry {
  client: string
  helper_seen_at: number | null
}

function isRosterEntry(value: unknown): value is CompanionRosterEntry {
  return isRecord(value) && typeof value.client === 'string'
    && (value.helper_seen_at === null || typeof value.helper_seen_at === 'number')
}

/**
 * 只读花名册：设置向导的“环境检查”用它判断哪些节点已经有助手在轮询。不创建
 * 任何任务，因此不会让在线助手执行一次真实探测。
 */
export function getCompanionRouteProbeRoster(
  clients: readonly string[],
  signal?: AbortSignal,
): Promise<CompanionRosterEntry[]> {
  if (!clients.length)
    return Promise.resolve([])
  const query = new URLSearchParams({ clients: clients.join(',') })
  return requestCompanion(`${COMPANION_ROOT}/roster?${query}`, { method: 'GET', signal }, (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.clients) || !payload.clients.every(isRosterEntry))
      throw new RouteProbeCompanionError(502, '伴生插件返回了无效的花名册数据')
    return payload.clients
  })
}
