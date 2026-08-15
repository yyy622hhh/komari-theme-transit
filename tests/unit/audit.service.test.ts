import type { AuditLogEntry, AuditLogsResponse } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import {
  collectAuditLogPages,
  MAX_AUDIT_EXPORT_RECORDS,
  MAX_AUDIT_LOG_PAGE_SIZE,
} from '../../src/services/audit.service'

function auditLog(id: number): AuditLogEntry {
  return {
    id,
    ip: '',
    message: `log-${id}`,
    msg_type: 'admin',
    time: '2026-08-15T00:00:00Z',
    uuid: '',
  }
}

describe('collectAuditLogPages', () => {
  test('deduplicates overlapping pages and stops at the reported total', async () => {
    const pages = [
      { logs: [auditLog(1), auditLog(2)], total: 3 },
      { logs: [auditLog(2), auditLog(3)], total: 3 },
    ]
    const requestedPages: number[] = []
    const result = await collectAuditLogPages(async (page): Promise<AuditLogsResponse> => {
      requestedPages.push(page)
      return pages[page - 1] ?? { logs: [], total: 3 }
    }, { pageSize: 2 })

    expect(result.logs.map(log => log.id)).toEqual([1, 2, 3])
    expect(result.reportedTotal).toBe(3)
    expect(result.truncated).toBe(false)
    expect(requestedPages).toEqual([1, 2])
  })

  test('caps the in-memory export and reports truncation', async () => {
    const result = await collectAuditLogPages(async (_page, limit) => ({
      logs: Array.from({ length: limit }, (_, index) => auditLog(index + 1)),
      total: MAX_AUDIT_EXPORT_RECORDS + 100,
    }), {
      maxRecords: 3,
      pageSize: MAX_AUDIT_LOG_PAGE_SIZE + 100,
    })

    expect(result.logs).toHaveLength(3)
    expect(result.reportedTotal).toBe(MAX_AUDIT_EXPORT_RECORDS + 100)
    expect(result.truncated).toBe(true)
  })
})
