import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isRpcPermissionError, KomariRpc, RpcClient, RpcError } from '../../src/utils/rpc'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSING
  }

  send(_data?: string): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

const originalWebSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

beforeEach(() => {
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  globalThis.fetch = originalFetch
})

describe('RpcClient WebSocket lifecycle', () => {
  test('rejects when the socket closes before opening', async () => {
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const connection = client.ensureWebSocketConnected()
    FakeWebSocket.instances[0]?.emitClose()

    await expect(connection).rejects.toThrow('WebSocket closed before connection opened')
    expect(client.getWebSocket()).toBeNull()
  })

  test('ignores a stale close event after a replacement connects', async () => {
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const firstConnection = client.ensureWebSocketConnected()
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()
    await firstConnection

    client.close()
    const secondConnection = client.ensureWebSocketConnected()
    const secondSocket = FakeWebSocket.instances[1]!
    secondSocket.open()
    await secondConnection

    firstSocket.emitClose()
    expect(client.getWebSocket()).toBe(secondSocket)
    client.close()
  })

  test('close immediately rejects an in-progress connection without waiting for onclose', async () => {
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const connection = client.ensureWebSocketConnected()

    client.close()

    await expect(connection).rejects.toThrow('WebSocket closed')
    expect(client.getWebSocket()).toBeNull()
  })

  test('switching to HTTP immediately cancels an in-progress WebSocket connection', async () => {
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const connection = client.ensureWebSocketConnected()

    client.setTransport(false)

    await expect(connection).rejects.toThrow('WebSocket transport disabled')
    expect(client.getWebSocket()).toBeNull()
  })

  test('aborting one call while connecting does not close the shared WebSocket', async () => {
    const controller = new AbortController()
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const call = client.call('rpc.ping', undefined, controller.signal)
    const socket = FakeWebSocket.instances[0]!

    controller.abort()
    await expect(call).rejects.toMatchObject({ code: -32800, message: 'Request aborted' })

    socket.open()
    await expect(client.ensureWebSocketConnected()).resolves.toBeUndefined()
    expect(client.getWebSocket()).toBe(socket)
    client.close()
  })

  test('switching to HTTP rejects requests pending on the old WebSocket', async () => {
    let requestSent!: () => void
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve
    })
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const call = client.call('rpc.ping')
    const socket = FakeWebSocket.instances[0]!
    socket.send = () => requestSent()
    socket.open()
    await sent

    client.setTransport(false)

    await expect(call).rejects.toThrow('WebSocket transport disabled')
  })

  test('a cancelled connection cannot clear or replace a later connection attempt', async () => {
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const firstConnection = client.ensureWebSocketConnected()
    const firstSocket = FakeWebSocket.instances[0]!
    client.close()
    await expect(firstConnection).rejects.toThrow('WebSocket closed')

    const secondConnection = client.ensureWebSocketConnected()
    const secondSocket = FakeWebSocket.instances[1]!
    firstSocket.open()
    secondSocket.open()
    await expect(secondConnection).resolves.toBeUndefined()
    expect(client.getWebSocket()).toBe(secondSocket)
    client.close()
  })

  test('rejects a read response that omits both result and error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({
      code: -32603,
      message: 'Invalid JSON-RPC response',
    })
  })

  test('rejects malformed HTTP responses with a typed RPC error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: 'pong' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    const call = client.call('rpc.ping')
    await expect(call).rejects.toBeInstanceOf(RpcError)
    await expect(call).rejects.toMatchObject({ code: -32603, message: 'Invalid JSON-RPC response' })
  })

  test('reports invalid JSON as a protocol parse error', async () => {
    globalThis.fetch = (async () => new Response('<html>proxy error</html>', {
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({
      code: -32700,
      message: 'Invalid JSON-RPC JSON response',
    })
  })

  test('rejects an HTTP response whose id does not match the request', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 999,
      result: 'pong',
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({
      code: -32603,
      message: 'Mismatched JSON-RPC response id',
    })
  })

  test('rejects malformed JSON-RPC errors even when no result is present', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: '-32000', message: 'invalid error code' },
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({
      code: -32603,
      message: 'Invalid JSON-RPC response',
    })
  })

  test('times out an HTTP request and distinguishes it from a network failure', async () => {
    let aborted = false
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 5 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({ code: -32001, message: 'Request timeout' })
    expect(aborted).toBe(true)
  })

  test('reports caller cancellation distinctly from timeout and network errors', async () => {
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })) as typeof fetch
    const controller = new AbortController()
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })
    const call = client.call('rpc.ping', undefined, controller.signal)

    controller.abort()
    await expect(call).rejects.toMatchObject({ code: -32800, message: 'Request aborted' })
  })

  test('forwards caller cancellation through public metric helper methods', async () => {
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })) as typeof fetch
    const controller = new AbortController()
    const rpc = new KomariRpc({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })
    const call = rpc.listPublicMetricDefinitions(controller.signal)

    controller.abort()
    await expect(call).rejects.toMatchObject({ code: -32800, message: 'Request aborted' })
  })

  test('rejects a pending WebSocket call immediately on malformed JSON-RPC', async () => {
    let requestId = 0
    let requestSent!: () => void
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve
    })
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 1_000, useWebSocket: true })
    const call = client.call('rpc.ping')
    const socket = FakeWebSocket.instances[0]!
    socket.send = (payload?: string) => {
      requestId = (JSON.parse(String(payload)) as { id: number }).id
      requestSent()
    }
    socket.open()
    await sent
    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code: 'bad', message: 'bad' } }),
    } as MessageEvent)
    await expect(call).rejects.toMatchObject({ code: -32603, message: 'Invalid JSON-RPC response' })
    client.close()
  })

  test('rejects a WebSocket read response that omits both result and error', async () => {
    let requestId = 0
    let requestSent!: () => void
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve
    })
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 1_000, useWebSocket: true })
    const call = client.call('rpc.ping')
    const socket = FakeWebSocket.instances[0]!
    socket.send = (payload?: string) => {
      requestId = (JSON.parse(String(payload)) as { id: number }).id
      requestSent()
    }
    socket.open()
    await sent
    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', id: requestId }),
    } as MessageEvent)

    await expect(call).rejects.toMatchObject({ code: -32603, message: 'Invalid JSON-RPC response' })
    client.close()
  })

  test('can fall back to HTTP after a WebSocket connection failure', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'pong' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })
    const websocketCall = client.call('rpc.ping')
    FakeWebSocket.instances[0]?.emitClose()
    await expect(websocketCall).rejects.toMatchObject({ code: -32000 })

    client.setTransport(false)
    await expect(client.call('rpc.ping')).resolves.toBe('pong')
    client.close()
  })

  test('runs privileged void calls over HTTP and accepts Komari omitted nil results', async () => {
    const methods: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number, method: string }
      methods.push(request.method)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const rpc = new KomariRpc({ baseUrl: 'http://example.test/api/rpc2', timeout: 100, useWebSocket: true })

    await rpc.orderClients({ a: 0 })
    await rpc.updateAdminSettings({ visitor_audit_enabled: true })
    await rpc.editClient({ uuid: 'client-a', tags: 'transit-route:ct=4809.4809@1755000000' })

    expect(methods).toEqual(['admin:orderClients', 'admin:editSettings', 'admin:editClient'])
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('Komari 1.4 RPC method compatibility', () => {
  test('uses the registered internal and backend method names', async () => {
    const calls: Array<{ method?: string, params?: unknown }> = []
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number, method: string, params?: unknown }
      calls.push({ method: request.method, params: request.params })
      const result = request.method === 'rpc.methods'
        ? ['rpc.ping']
        : request.method === 'rpc.help'
          ? { name: 'common:getNodes' }
          : request.method === 'rpc.version'
            ? '2.0'
            : { version: '1.4.2', hash: 'test' }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const rpc = new KomariRpc({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await expect(rpc.getMethods(true)).resolves.toEqual(['rpc.ping'])
    await expect(rpc.getHelp('common:getNodes')).resolves.toMatchObject({ name: 'common:getNodes' })
    await expect(rpc.getVersion()).resolves.toBe('2.0')
    await expect(rpc.getBackendVersion()).resolves.toEqual({ version: '1.4.2', hash: 'test' })

    expect(calls).toEqual([
      { method: 'rpc.methods', params: { internal: true } },
      { method: 'rpc.help', params: { method: 'common:getNodes' } },
      { method: 'rpc.version', params: undefined },
      { method: 'common:getVersion', params: undefined },
    ])
  })

  test('normalizes numeric public history parameters to the Komari string contract', async () => {
    const calls: Array<{ method: string, params?: Record<string, unknown> }> = []
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number, method: string, params?: Record<string, unknown> }
      calls.push(request)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { records: [], count: 0 } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const rpc = new KomariRpc({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    await rpc.getPublicRecordsByUUID({ uuid: 'node-1', hours: 24 })
    await rpc.getPublicPingRecords({ uuid: 'node-1', task_id: 2, hours: 6 })

    expect(calls.map(call => ({ method: call.method, params: call.params }))).toEqual([
      { method: 'public:getRecordsByUUID', params: { uuid: 'node-1', hours: '24' } },
      { method: 'public:getPingRecords', params: { uuid: 'node-1', task_id: '2', hours: '6' } },
    ])
  })

  test('recognizes Komari RPC permission codes without misclassifying server failures', () => {
    expect(isRpcPermissionError(new RpcError(-32040, 'unauthenticated'))).toBe(true)
    expect(isRpcPermissionError(new RpcError(-32041, 'permission denied'))).toBe(true)
    expect(isRpcPermissionError(new RpcError(-32603, 'internal error'))).toBe(false)
  })
})
