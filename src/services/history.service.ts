import type { PingRecord, PingTaskInfo, StatusRecord } from '@/utils/rpc'
import { requestManager } from '@/services/request.service'
import { ApiError, getSharedApi } from '@/utils/api'
import { normalizeConnectionCounts } from '@/utils/nodeMetricsHelper'
import { getSharedRpc, isRpcPermissionError, RpcError } from '@/utils/rpc'

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeHours(hours: number): number {
  return Math.max(1, Math.floor(hours))
}

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

function cachePart(value: string | number | undefined): string {
  return value === undefined ? 'all' : String(value)
}

function shouldRetryHistoryRequest(error: unknown): boolean {
  if (error instanceof RpcError)
    return !isRpcPermissionError(error)
  if (error instanceof ApiError)
    return error.code !== 401 && error.code !== 403
  return true
}

function shouldFallbackToLegacyRecordsApi(error: unknown): boolean {
  return error instanceof RpcError && (
    error.code === -32601
    || error.code === 404
    || error.code === 405
  )
}

type StatusRecordsPayload = Array<Partial<StatusRecord>> | Record<string, Array<Partial<StatusRecord>>>

function isStatusRecordsMap(records: StatusRecordsPayload): records is Record<string, Array<Partial<StatusRecord>>> {
  return !Array.isArray(records)
}

export function normalizeStatusRecordsPayload(records: StatusRecordsPayload | undefined): StatusRecord[] {
  if (!records)
    return []

  if (Array.isArray(records))
    return normalizeStatusRecords(records)

  if (isStatusRecordsMap(records))
    return Object.values(records).flatMap(clientRecords => normalizeStatusRecords(clientRecords))

  return []
}

export function getLoadRecordsRequestKey(uuid: string | undefined, hours: number, maxCount?: number): string {
  return `history:load:${cachePart(uuid)}:${normalizeHours(hours)}:${cachePart(normalizeMaxCount(maxCount))}`
}

export function getNodeLoadRecordsRequestKey(uuid: string, hours: number, maxCount?: number): string {
  return `history:node-load:${uuid}:${normalizeHours(hours)}:${cachePart(normalizeMaxCount(maxCount))}`
}

export function getPingRecordsRequestKey(hours: number, maxCount?: number, uuid?: string): string {
  return `history:ping:${cachePart(uuid)}:${normalizeHours(hours)}:${cachePart(normalizeMaxCount(maxCount))}`
}

export function getRecentNodeStatusRequestKey(uuid: string, limit: number): string {
  return `history:recent:${uuid}:${Math.max(1, Math.floor(limit))}`
}

export function normalizeStatusRecord(record: Partial<StatusRecord>): StatusRecord | null {
  if (!record.client || !record.time)
    return null

  // 历史记录与 `/latest` 用的是同一份上报结构：`connections` 含 UDP，必须与实时
  // 路径用同一个归一化，否则详情页折线图的 TCP 会把 UDP 重复算进去。
  const connections = normalizeConnectionCounts(
    numberOrZero(record.connections),
    numberOrZero(record.connections_udp),
  )

  return {
    client: record.client,
    time: record.time,
    cpu: numberOrZero(record.cpu),
    gpu: numberOrZero(record.gpu_average_usage ?? record.gpu),
    gpu_average_usage: typeof record.gpu_average_usage === 'number' && Number.isFinite(record.gpu_average_usage)
      ? record.gpu_average_usage
      : undefined,
    gpu_detailed_info: record.gpu_detailed_info,
    ram: numberOrZero(record.ram),
    ram_total: numberOrZero(record.ram_total),
    swap: numberOrZero(record.swap),
    swap_total: numberOrZero(record.swap_total),
    load: numberOrZero(record.load),
    load5: numberOrZero(record.load5 ?? record.load),
    load15: numberOrZero(record.load15 ?? record.load5 ?? record.load),
    temp: numberOrZero(record.temp),
    disk: numberOrZero(record.disk),
    disk_total: numberOrZero(record.disk_total),
    net_in: numberOrZero(record.net_in),
    net_out: numberOrZero(record.net_out),
    net_total_up: numberOrZero(record.net_total_up),
    net_total_down: numberOrZero(record.net_total_down),
    traffic_up: numberOrZero(record.traffic_up),
    traffic_down: numberOrZero(record.traffic_down),
    process: numberOrZero(record.process),
    connections: connections.tcp,
    connections_udp: connections.udp,
  }
}

export function normalizeStatusRecords(records: Array<Partial<StatusRecord>> | undefined): StatusRecord[] {
  return (records ?? [])
    .map(normalizeStatusRecord)
    .filter((record): record is StatusRecord => Boolean(record))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

export function buildRecordsByClient(records: StatusRecord[]): Map<string, StatusRecord[]> {
  const grouped = new Map<string, StatusRecord[]>()
  for (const record of records) {
    const clientRecords = grouped.get(record.client) ?? []
    clientRecords.push(record)
    grouped.set(record.client, clientRecords)
  }
  return grouped
}

export async function loadLoadRecords(uuid: string | undefined, hours: number, maxCount?: number, signal?: AbortSignal): Promise<StatusRecord[]> {
  const safeHours = normalizeHours(hours)
  const safeMaxCount = normalizeMaxCount(maxCount)
  return requestManager.run(
    getLoadRecordsRequestKey(uuid, safeHours, safeMaxCount),
    async (signal) => {
      const result = await getSharedRpc().getLoadRecords(uuid, safeHours, undefined, safeMaxCount, signal)
      return normalizeStatusRecordsPayload(result.records)
    },
    { shouldRetry: shouldRetryHistoryRequest, signal },
  )
}

export async function loadRecentNodeStatus(uuid: string, limit = 150, signal?: AbortSignal): Promise<StatusRecord[]> {
  const safeLimit = Math.max(1, Math.floor(limit))
  return requestManager.run(
    getRecentNodeStatusRequestKey(uuid, safeLimit),
    async (signal) => {
      const result = await getSharedRpc().getNodeRecentStatus(uuid, safeLimit, signal)
      // 与 loadLoadRecords 同一条归一化路径：详情页「实时」折线也来自
      // agent 的 connections=TCP+UDP 合计，不能原样当 TCP 画。
      return normalizeStatusRecords(result.records).slice(-safeLimit)
    },
    { shouldRetry: shouldRetryHistoryRequest, signal },
  )
}

export async function loadNodeLoadRecords(uuid: string, hours: number, maxCount?: number, signal?: AbortSignal): Promise<StatusRecord[]> {
  const safeHours = normalizeHours(hours)
  const safeMaxCount = normalizeMaxCount(maxCount)
  return requestManager.run(
    getNodeLoadRecordsRequestKey(uuid, safeHours, safeMaxCount),
    async (signal) => {
      try {
        const result = await getSharedRpc().getLoadRecords(uuid, safeHours, undefined, safeMaxCount, signal)
        return normalizeStatusRecordsPayload(result.records)
      }
      catch (error) {
        if (!shouldFallbackToLegacyRecordsApi(error))
          throw error
        if (signal.aborted)
          throw error
        const result = await getSharedApi().getLoadRecords(uuid, safeHours, safeMaxCount, signal)
        return normalizeStatusRecords(result.records)
      }
    },
    { shouldRetry: shouldRetryHistoryRequest, signal },
  )
}

export async function loadPingRecords(hours: number, maxCount?: number, uuid?: string, signal?: AbortSignal): Promise<PingRecord[]> {
  const safeHours = normalizeHours(hours)
  const safeMaxCount = normalizeMaxCount(maxCount)
  return requestManager.run(
    getPingRecordsRequestKey(safeHours, safeMaxCount, uuid),
    async (signal) => {
      const result = await getSharedRpc().getPingRecords(undefined, safeHours, safeMaxCount, signal, uuid)
      return result.records ?? []
    },
    { shouldRetry: shouldRetryHistoryRequest, signal },
  )
}

export async function loadPingRecordsWithTasks(hours: number, maxCount?: number, uuid?: string, signal?: AbortSignal): Promise<{ records: PingRecord[], tasks: PingTaskInfo[] }> {
  const safeHours = normalizeHours(hours)
  const safeMaxCount = normalizeMaxCount(maxCount)
  return requestManager.run(
    `${getPingRecordsRequestKey(safeHours, safeMaxCount, uuid)}:tasks`,
    async (signal) => {
      const result = await getSharedRpc().getPingRecords(undefined, safeHours, safeMaxCount, signal, uuid)
      return {
        records: result.records ?? [],
        tasks: result.tasks ?? [],
      }
    },
    { shouldRetry: shouldRetryHistoryRequest, signal },
  )
}
