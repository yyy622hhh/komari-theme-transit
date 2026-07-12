import type { AuditLogsResponse } from '@/utils/rpc'
import { requestManager } from '@/services/request.service'
import { getSharedRpc } from '@/utils/rpc'

const DEFAULT_AUDIT_LOG_LIMIT = 50

function normalizePositiveInteger(value: string | number | null | undefined, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0)
    return fallback
  return Math.floor(numericValue)
}

export function getAuditLogsRequestKey(page = 1, limit = DEFAULT_AUDIT_LOG_LIMIT): string {
  return `audit:logs:${page}:${limit}`
}

export function abortAuditLogs(page = 1, limit = DEFAULT_AUDIT_LOG_LIMIT): void {
  requestManager.abort(getAuditLogsRequestKey(page, limit))
}

export async function loadAuditLogs(params: { page?: number | string, limit?: number | string } = {}): Promise<AuditLogsResponse> {
  const page = normalizePositiveInteger(params.page, 1)
  const limit = normalizePositiveInteger(params.limit, DEFAULT_AUDIT_LOG_LIMIT)

  return requestManager.run(
    getAuditLogsRequestKey(page, limit),
    async signal => getSharedRpc().getAuditLogs(String(limit), String(page), signal),
  )
}
