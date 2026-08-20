import type { JsonRpcRequest, JsonRpcResponse } from '@/utils/rpcTypes'
import { NETWORK_CONFIG } from '@/constants/network'

/**
 * JSON-RPC 2.0 传输层：HTTP 与 WebSocket 两条通道、超时、重连和在途请求管理。
 *
 * 这里不认识任何 Komari 方法，只负责把一次调用送出去再把结果拿回来。方法定义在
 * `@/utils/rpc` 的 KomariRpc 里。
 */

const HTTP_PROTOCOL_PREFIX = 'http://'
const HTTPS_PROTOCOL_PREFIX = 'https://'
const WS_PROTOCOL_PREFIX = 'ws://'
const WSS_PROTOCOL_PREFIX = 'wss://'
const RPC_REQUEST_ABORTED = -32800
const RPC_METHODS_ALLOWING_MISSING_RESULT = new Set([
  'admin:addPingTask',
  'admin:deletePingTask',
  'admin:editPingTask',
  'admin:editSettings',
  'admin:orderClients',
])

function linkAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal)
    return () => {}

  const abort = () => controller.abort()
  if (signal.aborted) {
    abort()
    return () => {}
  }

  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

/** RPC 错误 */
export class RpcError extends Error {
  code: number
  data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/** Komari RPC2 authentication/authorization failures. */
export function isRpcPermissionError(error: unknown): boolean {
  return error instanceof RpcError
    && (error.code === -32040 || error.code === -32041 || error.code === 401 || error.code === 403)
}

/** RpcClient 配置选项 */
export interface RpcClientOptions {
  baseUrl?: string
  timeout?: number
  /** 是否使用 WebSocket，默认 false */
  useWebSocket?: boolean
}

/** JSON-RPC 2.0 客户端 */
export class RpcClient {
  private baseUrl: string
  private timeout: number
  private useWebSocket: boolean
  private ws: WebSocket | null = null
  private pendingRequests: Map<number | string, {
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
    timer: ReturnType<typeof setTimeout>
    allowMissingResult: boolean
  }> = new Map()

  private requestId = 0
  private wsCloseListeners = new Set<() => void>()
  /** WebSocket 连接 Promise（用于等待正在进行的连接） */
  private wsConnectPromise: Promise<void> | null = null
  private wsConnectReject: ((error: RpcError) => void) | null = null

  constructor(options: RpcClientOptions = {}) {
    const apiBase = import.meta.env.VITE_API_BASE || '/api'
    this.baseUrl = options.baseUrl || `${apiBase}/rpc2`
    this.timeout = options.timeout || NETWORK_CONFIG.timeout.request
    this.useWebSocket = options.useWebSocket || false
  }

  private getWebSocketUrl(): string {
    if (this.baseUrl.startsWith(HTTPS_PROTOCOL_PREFIX))
      return this.baseUrl.replace(HTTPS_PROTOCOL_PREFIX, WSS_PROTOCOL_PREFIX)
    if (this.baseUrl.startsWith(HTTP_PROTOCOL_PREFIX))
      return this.baseUrl.replace(HTTP_PROTOCOL_PREFIX, WS_PROTOCOL_PREFIX)

    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const url = new URL(this.baseUrl, origin || 'http://localhost')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  private rejectPendingRequests(error: RpcError): void {
    this.pendingRequests.forEach((pending, id) => {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(id)
    })
  }

  private parseJsonRpcResponse(raw: unknown, allowMissingResult = false): JsonRpcResponse | null {
    if (!raw || typeof raw !== 'object')
      return null
    const record = raw as Record<string, unknown>
    if (record.jsonrpc !== '2.0')
      return null
    if ('error' in record) {
      if (typeof record.id !== 'number' && typeof record.id !== 'string' && record.id !== null)
        return null
      const error = record.error as Record<string, unknown> | null
      if (!error || typeof error.code !== 'number' || typeof error.message !== 'string')
        return null
      return record as unknown as JsonRpcResponse
    }
    if (typeof record.id !== 'number' && typeof record.id !== 'string')
      return null

    // Komari's Go response uses `omitempty` for result. Mutations that return
    // nil therefore produce a success object with only jsonrpc and id. Only
    // the explicit void mutations above may use that compatibility path;
    // accepting it for reads would turn a truncated response into undefined.
    if (!Object.hasOwn(record, 'result') && !allowMissingResult)
      return null
    return record as unknown as JsonRpcResponse
  }

  private emitWebSocketClose(): void {
    this.wsCloseListeners.forEach(listener => listener())
  }

  /**
   * 调用 RPC 方法（HTTP POST）
   */
  private async callHttp<T>(method: string, params?: Record<string, unknown> | unknown[], signal?: AbortSignal): Promise<T> {
    const id = ++this.requestId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    }

    const controller = new AbortController()
    const unlinkAbortSignal = linkAbortSignal(controller, signal)
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeout)

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new RpcError(response.status, `HTTP error: ${response.status}`)
      }

      let rawResponse: unknown
      try {
        rawResponse = await response.json()
      }
      catch {
        throw new RpcError(-32700, 'Invalid JSON-RPC JSON response')
      }
      const data = this.parseJsonRpcResponse(
        rawResponse,
        RPC_METHODS_ALLOWING_MISSING_RESULT.has(method),
      ) as JsonRpcResponse<T> | null
      if (!data)
        throw new RpcError(-32603, 'Invalid JSON-RPC response')
      if (data.id !== id)
        throw new RpcError(-32603, 'Mismatched JSON-RPC response id')
      return this.handleResponse(data)
    }
    catch (error) {
      if (error instanceof RpcError)
        throw error
      if (signal?.aborted)
        throw new RpcError(RPC_REQUEST_ABORTED, 'Request aborted')
      if (timedOut)
        throw new RpcError(-32001, 'Request timeout')
      throw new RpcError(-32000, `Network error: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      clearTimeout(timeoutId)
      unlinkAbortSignal()
    }
  }

  /**
   * 确保 WebSocket 连接已建立并就绪
   * 如果已有连接正在建立中，等待其完成
   */
  private async ensureWebSocketReady(): Promise<void> {
    // 已连接，直接返回
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return
    }

    // 有正在进行的连接，等待它
    if (this.wsConnectPromise) {
      return this.wsConnectPromise
    }

    // 创建新连接
    const connection = this.initWebSocket()
    this.wsConnectPromise = connection
    try {
      await connection
    }
    finally {
      if (this.wsConnectPromise === connection)
        this.wsConnectPromise = null
    }
  }

  /**
   * 初始化 WebSocket 连接
   */
  private initWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWebSocketUrl()
      let opened = false
      let settled = false
      let socket: WebSocket
      let connectTimeout: ReturnType<typeof setTimeout>
      let cancelConnection: (error: RpcError) => void

      const clearConnectAttempt = () => {
        clearTimeout(connectTimeout)
        if (this.wsConnectReject === cancelConnection)
          this.wsConnectReject = null
      }
      const resolveConnection = () => {
        if (settled)
          return
        settled = true
        clearConnectAttempt()
        resolve()
      }
      const rejectConnection = (error: RpcError) => {
        if (settled)
          return
        settled = true
        clearConnectAttempt()
        reject(error)
      }
      connectTimeout = setTimeout(() => {
        if (this.ws === socket)
          this.ws = null
        if (socket.readyState === WebSocket.CONNECTING)
          socket.close()
        rejectConnection(new RpcError(-32001, 'WebSocket connection timeout'))
      }, this.timeout)

      cancelConnection = (error: RpcError) => rejectConnection(error)
      this.wsConnectReject = cancelConnection

      // 关闭现有连接（如果有）
      if (this.ws) {
        this.ws.onopen = null
        this.ws.onerror = null
        this.ws.onmessage = null
        this.ws.onclose = null
        if (this.ws.readyState !== WebSocket.CLOSED) {
          this.ws.close()
        }
      }

      socket = new WebSocket(wsUrl)
      this.ws = socket

      socket.onopen = () => {
        if (this.ws !== socket) {
          socket.close()
          rejectConnection(new RpcError(-32000, 'WebSocket connection superseded'))
          return
        }
        opened = true
        resolveConnection()
      }

      socket.onerror = () => {
        rejectConnection(new RpcError(-32000, 'WebSocket connection error'))
      }

      socket.onmessage = (event) => {
        let rawResponse: unknown
        try {
          rawResponse = JSON.parse(event.data)
        }
        catch {
          this.rejectPendingRequests(new RpcError(-32700, 'Invalid JSON-RPC JSON response'))
          return
        }

        const rawId = rawResponse && typeof rawResponse === 'object'
          ? (rawResponse as Record<string, unknown>).id
          : undefined
        const matchingPending = typeof rawId === 'number' || typeof rawId === 'string'
          ? this.pendingRequests.get(rawId)
          : undefined
        const data = this.parseJsonRpcResponse(rawResponse, matchingPending?.allowMissingResult)
        if (!data) {
          if (matchingPending)
            matchingPending.reject(new RpcError(-32603, 'Invalid JSON-RPC response'))
          else
            this.rejectPendingRequests(new RpcError(-32603, 'Invalid JSON-RPC response'))
          return
        }
        if (data.id === null)
          return
        const pending = this.pendingRequests.get(data.id)
        if (pending) {
          try {
            pending.resolve(this.handleResponse(data))
          }
          catch (error) {
            pending.reject(error)
          }
        }
      }

      socket.onclose = () => {
        if (!opened)
          rejectConnection(new RpcError(-32000, 'WebSocket closed before connection opened'))
        if (this.ws !== socket)
          return
        this.ws = null
        this.wsConnectPromise = null
        this.rejectPendingRequests(new RpcError(-32000, 'WebSocket closed'))
        this.emitWebSocketClose()
      }
    })
  }

  /**
   * 调用 RPC 方法（WebSocket）
   */
  private async callWebSocket<T>(method: string, params?: Record<string, unknown> | unknown[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted)
      throw new RpcError(RPC_REQUEST_ABORTED, 'Request aborted')

    if (signal) {
      let abortConnectionWait = () => {}
      const aborted = new Promise<never>((_, reject) => {
        abortConnectionWait = () => reject(new RpcError(RPC_REQUEST_ABORTED, 'Request aborted'))
        signal.addEventListener('abort', abortConnectionWait, { once: true })
      })
      try {
        await Promise.race([this.ensureWebSocketReady(), aborted])
      }
      finally {
        signal.removeEventListener('abort', abortConnectionWait)
      }
    }
    else {
      await this.ensureWebSocketReady()
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RpcError(RPC_REQUEST_ABORTED, 'Request aborted'))
        return
      }

      const id = ++this.requestId
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        method,
        params,
        id,
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let abort = () => {}

      const cleanup = (): boolean => {
        if (settled)
          return false
        settled = true
        signal?.removeEventListener('abort', abort)
        this.pendingRequests.delete(id)
        if (timer)
          clearTimeout(timer)
        return true
      }

      abort = () => {
        if (cleanup())
          reject(new RpcError(RPC_REQUEST_ABORTED, 'Request aborted'))
      }

      timer = setTimeout(() => {
        if (cleanup())
          reject(new RpcError(-32001, 'Request timeout'))
      }, this.timeout)

      if (signal)
        signal.addEventListener('abort', abort, { once: true })

      this.pendingRequests.set(id, {
        resolve: (value) => {
          if (cleanup())
            resolve(value as T)
        },
        reject: (reason) => {
          if (cleanup())
            reject(reason)
        },
        timer,
        allowMissingResult: RPC_METHODS_ALLOWING_MISSING_RESULT.has(method),
      })

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (cleanup())
          reject(new RpcError(-32000, 'WebSocket not connected'))
        return
      }

      try {
        this.ws.send(JSON.stringify(request))
      }
      catch (error) {
        if (cleanup())
          reject(new RpcError(-32000, `WebSocket send failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /**
   * 处理响应
   */
  private handleResponse<T>(response: JsonRpcResponse<T>): T {
    if ('error' in response) {
      throw new RpcError(response.error.code, response.error.message, response.error.data)
    }
    return response.result as T
  }

  /**
   * 调用 RPC 方法
   */
  async call<T>(method: string, params?: Record<string, unknown> | unknown[], signal?: AbortSignal): Promise<T> {
    if (this.useWebSocket) {
      return this.callWebSocket<T>(method, params, signal)
    }
    return this.callHttp<T>(method, params, signal)
  }

  /**
   * Execute a call over HTTP even when realtime reads use WebSocket.
   * Komari 1.4 binds a WebSocket principal at handshake time, so privileged
   * mutations must use HTTP to re-evaluate the current session cookie.
   */
  async callOverHttp<T>(method: string, params?: Record<string, unknown> | unknown[], signal?: AbortSignal): Promise<T> {
    return this.callHttp<T>(method, params, signal)
  }

  /**
   * 切换传输方式
   */
  setTransport(useWebSocket: boolean): void {
    if (this.useWebSocket !== useWebSocket) {
      this.useWebSocket = useWebSocket
      if (!useWebSocket)
        this.closeWebSocket('WebSocket transport disabled')
    }
  }

  /**
   * 确保 WebSocket 连接已建立
   */
  async ensureWebSocketConnected(): Promise<void> {
    await this.ensureWebSocketReady()
  }

  /**
   * 确保 WebSocket 连接已建立并通过 ping 验证
   */
  async ensureWebSocketConnectedWithPing(timeoutMs = 10000): Promise<void> {
    await this.ensureWebSocketReady()

    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        this.callWebSocket<string>('rpc.ping'),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new RpcError(-32001, 'WebSocket ping timeout')), timeoutMs)
        }),
      ])
    }
    catch (error) {
      this.close()
      throw error
    }
    finally {
      if (timeoutId)
        clearTimeout(timeoutId)
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.closeWebSocket('WebSocket closed')
  }

  private closeWebSocket(message: string): void {
    const socket = this.ws
    this.ws = null
    this.wsConnectReject?.(new RpcError(-32000, message))
    this.wsConnectReject = null
    this.wsConnectPromise = null
    this.rejectPendingRequests(new RpcError(-32000, message))

    if (!socket)
      return
    socket.onopen = null
    socket.onerror = null
    socket.onmessage = null
    socket.onclose = null
    if (socket.readyState !== WebSocket.CLOSED)
      socket.close()
  }

  onWebSocketClose(listener: () => void): () => void {
    this.wsCloseListeners.add(listener)
    return () => this.wsCloseListeners.delete(listener)
  }

  /**
   * 获取 WebSocket 连接状态
   */
  getWsReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED
  }

  /**
   * 获取 WebSocket 实例（用于状态监控）
   */
  getWebSocket(): WebSocket | null {
    return this.ws
  }
}
