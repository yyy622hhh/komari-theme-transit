import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcClient, RpcError } from '../../src/utils/rpc'

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

  send(): void {}

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

  test('rejects malformed HTTP responses with a typed RPC error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 100 })

    const call = client.call('rpc.ping')
    await expect(call).rejects.toBeInstanceOf(RpcError)
    await expect(call).rejects.toMatchObject({ code: -32603, message: 'Invalid JSON-RPC response' })
  })

  test('times out an HTTP request and aborts the underlying fetch', async () => {
    let aborted = false
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })) as typeof fetch
    const client = new RpcClient({ baseUrl: 'http://example.test/api/rpc2', timeout: 5 })

    await expect(client.call('rpc.ping')).rejects.toMatchObject({ code: -32000 })
    expect(aborted).toBe(true)
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
})
