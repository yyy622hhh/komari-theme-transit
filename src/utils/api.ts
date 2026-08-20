/** API 响应基础结构 */
import type {
  ApiClientOptions,
  ApiResponse,
  LoadRecordsResponse,
  MeInfo,
  NodeInfo,
  PingRecordsResponse,
  PublicSettings,
  RealtimeStatus,
  VersionInfo,
  WebSocketRealtimeResponse,
} from './api.types'

// ==================== 类型定义 ====================

import { NETWORK_CONFIG } from '@/constants/network'

/**
 * Komari API 客户端 SDK
 * 基于 REST API 的 Komari 客户端
 * @see https://www.komari.wiki/dev/api.html
 */

const HTTP_PROTOCOL_REGEX = /^http/
const HTTPS_PROTOCOL_REGEX = /^https/

export type * from './api.types'

export class ApiError extends Error {
  status: string
  code?: number

  constructor(message: string, status: string = 'error', code?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// ==================== API 客户端 ====================

/** Komari API 客户端 */
function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  if (!value || typeof value !== 'object')
    return false
  const record = value as Record<string, unknown>
  return (record.status === 'success' || record.status === 'error') && 'data' in record
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  }
  catch {
    return null
  }
}

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

export class KomariApi {
  private baseUrl: string
  private timeout: number

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl || import.meta.env.VITE_API_BASE || '/api'
    this.timeout = options.timeout || NETWORK_CONFIG.timeout.request
  }

  /**
   * 发送 GET 请求
   */
  private async get<T>(path: string, params?: Record<string, string | number | null | undefined>, signal?: AbortSignal): Promise<T> {
    let url = `${this.baseUrl}${path}`
    if (params) {
      const searchParams = new URLSearchParams()
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value))
        }
      })
      const queryString = searchParams.toString()
      if (queryString) {
        url += `?${queryString}`
      }
    }

    const controller = new AbortController()
    const unlinkAbortSignal = linkAbortSignal(controller, signal)
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include', // 携带 Cookie
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const result = await safeJson(response)
      if (!isApiResponse<T>(result))
        throw new ApiError(response.ok ? 'Invalid API response' : `HTTP error: ${response.status}`, 'error', response.status)

      if (result.status === 'error') {
        throw new ApiError(result.message || 'Unknown error', 'error', response.status)
      }

      return result.data
    }
    catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof ApiError)
        throw error
      throw new ApiError(`Network error: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    finally {
      unlinkAbortSignal()
    }
  }

  /**
   * 发送 GET 请求（直接返回响应，不解析 ApiResponse 结构）
   */
  private async getRaw<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const controller = new AbortController()
    const unlinkAbortSignal = linkAbortSignal(controller, signal)
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new ApiError(`HTTP error: ${response.status}`, 'error', response.status)
      }

      const result = await safeJson(response)
      if (result === null)
        throw new ApiError('Invalid JSON response', 'error', response.status)
      return result as T
    }
    catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof ApiError)
        throw error
      throw new ApiError(`Network error: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    finally {
      unlinkAbortSignal()
    }
  }

  /**
   * 发送 POST 请求
   */
  private async post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const controller = new AbortController()
    const unlinkAbortSignal = linkAbortSignal(controller, signal)
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const result = await safeJson(response)
      if (!result || typeof result !== 'object')
        throw new ApiError(response.ok ? 'Invalid API response' : `HTTP error: ${response.status}`, 'error', response.status)

      // 登录接口返回 set-cookie 特殊结构
      if ('set-cookie' in result) {
        return result as T
      }

      // 检查 API 响应状态
      if (!isApiResponse<T>(result))
        throw new ApiError(response.ok ? 'Invalid API response' : `HTTP error: ${response.status}`, 'error', response.status)
      if (result.status === 'error') {
        throw new ApiError(result.message || 'Unknown error', 'error', response.status)
      }

      return result.data
    }
    catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof ApiError)
        throw error
      throw new ApiError(`Network error: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    finally {
      unlinkAbortSignal()
    }
  }

  // ===== 用户信息接口 =====

  /**
   * 获取当前用户信息
   * 注意：此接口返回的是直接的 MeInfo 对象，不是包裹在 { status, message, data } 中
   */
  async getMe(signal?: AbortSignal): Promise<MeInfo> {
    return this.getRaw<MeInfo>('/me', signal)
  }

  // ===== 服务端公开属性 =====

  /**
   * 获取站点的公开设置属性
   */
  async getPublicSettings(signal?: AbortSignal): Promise<PublicSettings> {
    return this.get<PublicSettings>('/public', undefined, signal)
  }

  /**
   * 获取服务端版本信息
   */
  async getVersion(): Promise<VersionInfo> {
    return this.get<VersionInfo>('/version')
  }

  // ===== 节点信息 =====

  /**
   * 获取所有节点的基本信息列表
   */
  async getNodes(): Promise<NodeInfo[]> {
    return this.get<NodeInfo[]>('/nodes')
  }

  /**
   * 获取指定节点最近1分钟的历史数据
   * @param uuid 节点 UUID
   */
  async getNodeRecentStatus(uuid: string): Promise<RealtimeStatus[]> {
    return this.get<RealtimeStatus[]>(`/recent/${uuid}`)
  }

  // ===== 历史记录 =====

  /**
   * 获取指定节点的负载历史记录
   * @param uuid 节点 UUID
   * @param hours 查询时间范围（小时）
   */
  async getLoadRecords(uuid: string, hours: number, maxCount?: number, signal?: AbortSignal): Promise<LoadRecordsResponse> {
    return this.get<LoadRecordsResponse>('/records/load', { uuid, hours, max_count: maxCount }, signal)
  }

  /**
   * 获取指定节点的 Ping 历史记录
   * @param uuid 节点 UUID
   * @param hours 查询时间范围（小时）
   */
  async getPingRecords(uuid: string, hours: number, signal?: AbortSignal): Promise<PingRecordsResponse> {
    return this.get<PingRecordsResponse>('/records/ping', { uuid, hours }, signal)
  }
}

// ==================== WebSocket 实时状态客户端 ====================

/** WebSocket 实时状态客户端 */
export class RealtimeWebSocket {
  private ws: WebSocket | null = null
  private url: string
  private reconnectInterval: number
  private maxReconnectAttempts: number
  private reconnectAttempts = 0
  private listeners: Set<(data: WebSocketRealtimeResponse) => void> = new Set()
  private errorListeners: Set<(error: Event) => void> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private isOpen = false

  constructor(options: {
    baseUrl?: string
    reconnectInterval?: number
    maxReconnectAttempts?: number
  } = {}) {
    const baseUrl = options.baseUrl || '/api/clients'
    this.url = baseUrl.replace(HTTP_PROTOCOL_REGEX, 'ws').replace(HTTPS_PROTOCOL_REGEX, 'wss')
    this.reconnectInterval = options.reconnectInterval || 3000
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5
  }

  /**
   * 连接 WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
          this.isOpen = true
          this.reconnectAttempts = 0
          // 发送获取数据请求
          this.ws!.send('get')
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as WebSocketRealtimeResponse
            if (data?.status === 'success' || data?.status === 'error')
              this.listeners.forEach(listener => listener(data))
          }
          catch {
            // Ignore parse errors
          }
        }

        this.ws.onerror = (error) => {
          this.errorListeners.forEach(listener => listener(error))
          if (!this.isOpen) {
            reject(new ApiError('WebSocket connection failed', 'error'))
          }
        }

        this.ws.onclose = () => {
          this.isOpen = false
          if (this.shouldReconnect)
            this.attemptReconnect()
        }
      }
      catch (error) {
        reject(new ApiError(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`, 'error'))
      }
    })
  }

  /**
   * 尝试重连
   */
  private attemptReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts)
      return

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // Ignore reconnect errors
      })
    }, this.reconnectInterval)
  }

  /**
   * 请求数据
   */
  requestData(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send('get')
    }
  }

  /**
   * 订阅实时数据
   */
  subscribe(callback: (data: WebSocketRealtimeResponse) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * 订阅错误事件
   */
  onError(callback: (error: Event) => void): () => void {
    this.errorListeners.add(callback)
    return () => {
      this.errorListeners.delete(callback)
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.isOpen = false
    this.listeners.clear()
    this.errorListeners.clear()
  }

  /**
   * 获取连接状态
   */
  get connected(): boolean {
    return this.isOpen && this.ws?.readyState === WebSocket.OPEN
  }
}

// ==================== 单例实例 ====================

let sharedApiInstance: KomariApi | null = null

/**
 * 获取共享的 KomariApi 实例
 */
export function getSharedApi(options?: ApiClientOptions): KomariApi {
  if (!sharedApiInstance) {
    sharedApiInstance = new KomariApi(options)
  }
  return sharedApiInstance
}

/**
 * 重置共享实例
 */
export function resetSharedApi(): void {
  sharedApiInstance = null
}

// 默认导出
export default KomariApi
