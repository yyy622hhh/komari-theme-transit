import type { AuditLogEntry, AuditLogsResponse } from '@/utils/rpc'
import { requestManager } from '@/services/request.service'
import { getSharedRpc } from '@/utils/rpc'

const DEFAULT_AUDIT_LOG_LIMIT = 50
export const MAX_AUDIT_LOG_PAGE_SIZE = 200
export const MAX_AUDIT_EXPORT_RECORDS = 5_000

export interface AuditLogExportResult {
  logs: AuditLogEntry[]
  reportedTotal: number
  truncated: boolean
}

interface CollectAuditLogPagesOptions {
  maxRecords?: number
  msgType?: string
  pageSize?: number
  yieldBetweenPages?: () => Promise<void>
}

function normalizePositiveInteger(value: string | number | null | undefined, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0)
    return fallback
  return Math.floor(numericValue)
}

export function getAuditLogsRequestKey(page = 1, limit = DEFAULT_AUDIT_LOG_LIMIT, msgType?: string): string {
  return `audit:logs:${page}:${limit}:${msgType?.trim() || 'all'}`
}

export function abortAuditLogs(page = 1, limit = DEFAULT_AUDIT_LOG_LIMIT, msgType?: string): void {
  requestManager.abort(getAuditLogsRequestKey(page, limit, msgType))
}

export async function loadAuditLogs(params: { page?: number | string, limit?: number | string, msgType?: string } = {}): Promise<AuditLogsResponse> {
  const page = normalizePositiveInteger(params.page, 1)
  const limit = Math.min(normalizePositiveInteger(params.limit, DEFAULT_AUDIT_LOG_LIMIT), MAX_AUDIT_LOG_PAGE_SIZE)
  const msgType = params.msgType?.trim() || undefined

  return requestManager.run(
    getAuditLogsRequestKey(page, limit, msgType),
    async signal => getSharedRpc().getAuditLogs(String(limit), String(page), msgType, signal),
  )
}

export async function collectAuditLogPages(
  loadPage: (page: number, limit: number, msgType?: string) => Promise<AuditLogsResponse>,
  options: CollectAuditLogPagesOptions = {},
): Promise<AuditLogExportResult> {
  const maxRecords = Math.min(
    normalizePositiveInteger(options.maxRecords, MAX_AUDIT_EXPORT_RECORDS),
    MAX_AUDIT_EXPORT_RECORDS,
  )
  const pageSize = Math.min(
    normalizePositiveInteger(options.pageSize, MAX_AUDIT_LOG_PAGE_SIZE),
    MAX_AUDIT_LOG_PAGE_SIZE,
  )
  const msgType = options.msgType?.trim() || undefined
  const collected: AuditLogEntry[] = []
  const seenIds = new Set<number>()
  let page = 1
  let reportedTotal = 0
  let mayHaveMore = false

  while (collected.length < maxRecords) {
    const result = await loadPage(page, pageSize, msgType)
    const pageLogs = result.logs ?? []
    if (Number.isFinite(result.total) && result.total > reportedTotal)
      reportedTotal = result.total

    let added = 0
    for (const log of pageLogs) {
      if (seenIds.has(log.id))
        continue
      seenIds.add(log.id)
      collected.push(log)
      added++
      if (collected.length >= maxRecords)
        break
    }

    const reachedReportedTotal = reportedTotal > 0 && collected.length >= reportedTotal
    mayHaveMore = !reachedReportedTotal && pageLogs.length >= pageSize
    if (!pageLogs.length || !added || reachedReportedTotal || pageLogs.length < pageSize || collected.length >= maxRecords)
      break

    page++
    await options.yieldBetweenPages?.()
  }

  return {
    logs: collected,
    reportedTotal,
    truncated: reportedTotal > collected.length || (collected.length >= maxRecords && mayHaveMore),
  }
}

export async function loadAuditLogExport(options: CollectAuditLogPagesOptions = {}): Promise<AuditLogExportResult> {
  return collectAuditLogPages(
    (page, limit, msgType) => loadAuditLogs({ page, limit, msgType }),
    options,
  )
}

export async function updateVisitorAuditEnabled(enabled: boolean): Promise<void> {
  await requestManager.run(
    'audit:visitor-setting',
    async signal => getSharedRpc().updateAdminSettings({ visitor_audit_enabled: enabled }, signal),
    { retryAttempts: 0 },
  )
}
