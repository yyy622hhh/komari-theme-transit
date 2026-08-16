import type { NodeData } from '../../src/stores/nodes'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createTopologyPingTask, ensureTopologyPingTask } from '../../src/services/topology-tasks.service'
import { resetSharedRpc } from '../../src/utils/rpc'

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    uuid: 'riven',
    name: 'Riven-JP',
    online: true,
    ipv4: '45.94.40.40',
    ipv6: '',
    ...overrides,
  } as NodeData
}

afterEach(() => {
  mock.restore()
  resetSharedRpc()
})

describe('createTopologyPingTask', () => {
  test('creates an ICMP task that only runs on the selected relay node', async () => {
    const originalFetch = globalThis.fetch
    let request: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { task_id: 21 } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await createTopologyPingTask(
        node(),
        node({ uuid: 'misaka', name: 'Misaka-US-SJC', ipv4: '201.4.14.115' }),
      )

      expect(result).toMatchObject({ task_id: 21 })
      expect(result.name).toMatch(/^Transit-Riven-JP-to-Misaka-US-SJC \[riven-misaka-[a-z0-9]+\]$/)
      expect(request).toMatchObject({
        method: 'admin:addPingTask',
        params: {
          clients: ['riven'],
          default_on: false,
          name: result.name,
          target: '201.4.14.115',
          type: 'icmp',
          interval: 30,
        },
      })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refuses to generate a task when the target has no public address', async () => {
    await expect(createTopologyPingTask(node(), node({ uuid: 'target', name: 'Target', ipv4: '', ipv6: '' })))
      .rejects
      .toThrow('没有公网 IP')
  })

  test('refuses a self-ping task before calling the server', async () => {
    await expect(createTopologyPingTask(node(), node()))
      .rejects
      .toThrow('不能是同一台节点')
  })

  test('does not reuse a same-named task that points to another destination', async () => {
    const originalFetch = globalThis.fetch
    const methods: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number, method: string }
      methods.push(request.method)
      const result = request.method === 'admin:getAllPingTasks'
        ? [{
            id: 55,
            name: 'Transit-Riven-JP-to-Misaka-US-SJC',
            target: '201.4.14.116',
            type: 'icmp',
            interval: 30,
            default_on: false,
            clients: ['riven'],
          }]
        : { task_id: 22 }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await ensureTopologyPingTask(
        node(),
        node({ uuid: 'misaka', name: 'Misaka-US-SJC', ipv4: '201.4.14.115' }),
      )

      expect(result.created).toBe(true)
      expect(methods).toEqual(['admin:getAllPingTasks', 'admin:addPingTask'])
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
