import { afterEach, describe, expect, test } from 'bun:test'
import { loadNodeLoadRecords, loadRecentNodeStatus, normalizeStatusRecord } from '../../src/services/history.service'
import { resetSharedApi } from '../../src/utils/api'
import { normalizeConnectionCounts } from '../../src/utils/nodeMetricsHelper'
import { resetSharedRpc } from '../../src/utils/rpc'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetSharedRpc()
  resetSharedApi()
})

function rpcErrorResponse(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('loadNodeLoadRecords compatibility fallback', () => {
  test('uses the legacy REST endpoint only when the RPC method is unavailable', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/rpc2')) {
        const request = JSON.parse(String(init?.body)) as { id: number }
        return rpcErrorResponse(request.id, -32601, 'method not found')
      }
      return new Response(JSON.stringify({ status: 'success', message: '', data: { count: 0, records: [] } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await expect(loadNodeLoadRecords('fallback-node', 1)).resolves.toEqual([])
    expect(urls.some(url => url.includes('/records/load'))).toBe(true)
  })

  test('does not bypass an RPC permission denial through the legacy REST endpoint', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      urls.push(url)
      const request = JSON.parse(String(init?.body)) as { id: number }
      return rpcErrorResponse(request.id, -32041, 'permission denied')
    }) as typeof fetch

    await expect(loadNodeLoadRecords('permission-node', 1)).rejects.toMatchObject({ code: -32041 })
    expect(urls.some(url => url.includes('/records/load'))).toBe(false)
  })
})

describe('normalizeStatusRecord connection counts', () => {
  const base = { client: 'node-a', time: '2026-08-18T00:00:00.000Z' }

  test('splits the reported total into TCP and UDP like the realtime path', () => {
    const record = normalizeStatusRecord({ ...base, connections: 120, connections_udp: 20 })
    expect(record?.connections).toBe(100)
    expect(record?.connections_udp).toBe(20)
  })

  test('matches normalizeConnectionCounts so charts and cards cannot disagree', () => {
    const raw = { connections: 341, connections_udp: 57 }
    const record = normalizeStatusRecord({ ...base, ...raw })
    const realtime = normalizeConnectionCounts(raw.connections, raw.connections_udp)
    expect({ tcp: record?.connections, udp: record?.connections_udp }).toEqual(realtime)
  })

  test('never reports a negative TCP count when the backend is inconsistent', () => {
    const record = normalizeStatusRecord({ ...base, connections: 5, connections_udp: 20 })
    expect(record?.connections).toBe(0)
    expect(record?.connections_udp).toBe(5)
  })

  test('normalizes recent realtime status so the TCP series does not include UDP', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes('/rpc2')) {
        const request = JSON.parse(String(init?.body)) as { id: number }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            count: 1,
            records: [{
              client: 'node-a',
              time: '2026-08-18T00:00:00.000Z',
              connections: 120,
              connections_udp: 20,
            }],
          },
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    const records = await loadRecentNodeStatus('node-a', 10)
    expect(records).toHaveLength(1)
    expect(records[0]?.connections).toBe(100)
    expect(records[0]?.connections_udp).toBe(20)
  })

  test('keeps GPU detail fields so history charts can draw device series', () => {
    const record = normalizeStatusRecord({
      ...base,
      gpu: 0,
      gpu_average_usage: 42,
      gpu_detailed_info: [{ device_index: 0, utilization: 40, memory_used: 4, memory_total: 8 }],
    })
    expect(record?.gpu).toBe(42)
    expect(record?.gpu_average_usage).toBe(42)
    expect(record?.gpu_detailed_info?.[0]).toMatchObject({ utilization: 40 })
  })

  test('treats missing connection fields as zero', () => {
    const record = normalizeStatusRecord({ ...base })
    expect(record?.connections).toBe(0)
    expect(record?.connections_udp).toBe(0)
  })
})
