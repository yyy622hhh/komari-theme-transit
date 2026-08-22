import type { useAppStore } from '@/stores/app'
import type { useNodesStore } from '@/stores/nodes'
import type { InitConfig } from '@/utils/init.shared'
import type { Client, KomariRpc, NodeStatus } from '@/utils/rpc'
import { calculatePollingInterval, raceWithAbort, shouldLogPollingFailure } from '@/utils/init.shared'
import { RpcError } from '@/utils/rpc'
import { logAppError, logAppWarning } from '@/utils/safeError'

export interface TransportManagerDeps {
  rpc: KomariRpc
  appStore: ReturnType<typeof useAppStore>
  nodesStore: ReturnType<typeof useNodesStore>
  config: Required<InitConfig>
  /** InitManager 拥有 transportController/transportGeneration，这里只读它的判断结果。 */
  isTransportCurrent: (generation: number) => boolean
  /** InitManager 拥有 transportController，signal 会在会话恢复时被替换，必须现取。 */
  getTransportSignal: () => AbortSignal
  /**
   * 节点快照缓存（新鲜度判断与实际抓取）仍归 InitManager 管理，因为初始化和
   *  按需刷新（refreshNodeClients）也要复用同一份缓存，不只是轮询在用。
   */
  shouldRefreshClients: (now: number) => boolean
  markClientsFetchAttempt: (now: number) => void
  fetchClients: (signal: AbortSignal) => Promise<Record<string, Client>>
  markClientsFetched: (now: number) => void
}

/**
 * WebSocket 连接、重连回落与轮询这一簇，从 `InitManager` 拆出来只是为了把
 * 那个类顶到 600 行的部分挪走。世代号（transportGeneration）和它对应的
 * AbortController 仍然由 `InitManager` 持有并通过 `isTransportCurrent` /
 * `getTransportSignal` 注入，因为会话恢复（revalidateSessionAndTransport）
 * 需要在替换世代号的同时让轮询/重连的旧任务失效——这一判断口径必须唯一。
 */
export class TransportManager {
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeWsClose: (() => void) | null = null
  private pollingGeneration: number | null = null
  private refreshAfterCurrentPoll = false
  private useWebSocket: boolean | null = null
  private postFailureCount = 0

  constructor(private readonly deps: TransportManagerDeps) {}

  resetFailureCount(): void {
    this.postFailureCount = 0
  }

  private getPollInterval(): number {
    return calculatePollingInterval(
      this.deps.appStore.dataUpdateInterval * 1000,
      this.postFailureCount,
      this.deps.config.postMaxRetryInterval,
    )
  }

  start(generation: number): void {
    if (!this.deps.isTransportCurrent(generation))
      return
    // 根据主题配置决定初始连接模式
    const configuredMode = this.deps.appStore.rpcTransportMode
    this.useWebSocket = configuredMode === 'websocket'

    if (this.useWebSocket) {
      // 尝试建立 WebSocket 连接
      void this.connectWebSocket(generation)
    }
    else {
      // HTTP 模式：直接设置 RPC 客户端为 HTTP 模式
      const client = this.deps.rpc.getClient()
      client.setTransport(false)
      this.deps.nodesStore.updateWsState('disconnected', this.deps.config.wsMaxReconnectAttempts)
    }

    // 开始轮询（作为 WebSocket 的补充或备选方案）
    this.startPolling(generation)
  }

  private async connectWebSocket(generation: number): Promise<void> {
    // 如果已回落到 POST 模式或配置为 HTTP 模式，不再尝试 WebSocket
    if (!this.deps.isTransportCurrent(generation) || this.useWebSocket === false) {
      return
    }

    const client = this.deps.rpc.getClient()

    // 切换到 WebSocket 模式
    client.setTransport(true)
    this.deps.nodesStore.updateWsState('connecting', this.deps.nodesStore.wsReconnectAttempts)

    try {
      // 使用 ping 验证连接，10 秒超时
      await raceWithAbort(client.ensureWebSocketConnectedWithPing(10000), this.deps.getTransportSignal())
      if (!this.deps.isTransportCurrent(generation) || !this.useWebSocket) {
        client.close()
        return
      }
      this.deps.nodesStore.updateWsState('connected', 0)

      // 连接成功，重置错误状态
      this.deps.appStore.connectionError = false

      // 监听连接状态变化
      this.monitorWebSocketConnection(generation)
    }
    catch (error) {
      if (!this.deps.isTransportCurrent(generation) || !this.useWebSocket)
        return
      logAppError('WebSocket connection failed', error)
      this.deps.nodesStore.updateWsState('disconnected')
      this.scheduleReconnect(generation)
    }
  }

  /**
   * 监控 WebSocket 连接状态
   */
  private monitorWebSocketConnection(generation: number): void {
    this.unsubscribeWsClose?.()
    const client = this.deps.rpc.getClient()
    this.unsubscribeWsClose = client.onWebSocketClose(() => {
      if (!this.deps.isTransportCurrent(generation))
        return
      // 如果当前是已连接状态且还在使用 WebSocket 模式，触发重连
      if (this.useWebSocket === true && this.deps.nodesStore.wsConnectionState === 'connected') {
        this.deps.nodesStore.updateWsState('disconnected')
        this.scheduleReconnect(generation)
      }
    })
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(generation: number): void {
    if (!this.deps.isTransportCurrent(generation) || this.useWebSocket === false || this.reconnectTimer)
      return

    const attempts = this.deps.nodesStore.wsReconnectAttempts

    // 达到最大重连次数，回落到 POST 模式
    if (attempts >= this.deps.config.wsMaxReconnectAttempts) {
      console.error('[InitManager] Max reconnect attempts reached, falling back to POST mode')
      this.fallbackToPostMode(generation)
      return
    }

    // 首次失败时显示提示
    if (attempts === 0) {
      window.$message?.error('WebSocket 建立失败，正在尝试重连。')
    }

    const nextAttempts = attempts + 1
    this.deps.nodesStore.updateWsState('reconnecting', nextAttempts)
    const backoff = Math.min(this.deps.config.wsReconnectInterval * 2 ** Math.max(0, nextAttempts - 1), 30_000)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        const client = this.deps.rpc.getClient()
        client.close()
        await this.connectWebSocket(generation)
      }
      catch (error) {
        if (!this.deps.isTransportCurrent(generation))
          return
        logAppError('WebSocket reconnect failed', error)
        this.scheduleReconnect(generation)
      }
    }, backoff)
  }

  /**
   * 回落到 POST 模式
   */
  private fallbackToPostMode(generation: number): void {
    if (!this.deps.isTransportCurrent(generation))
      return
    this.useWebSocket = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.deps.nodesStore.updateWsState('disconnected', this.deps.config.wsMaxReconnectAttempts)

    // 关闭 WebSocket 连接
    const client = this.deps.rpc.getClient()
    client.setTransport(false)
    client.close()

    // 显示提示
    window.$message?.warning('WebSocket 无法连接，尝试回落 POST 模式。')
  }

  /**
   * 开始轮询
   */
  private startPolling(generation: number): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }

    if (!this.deps.isTransportCurrent(generation) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      this.pollTimer = null
      return
    }

    const schedulePoll = () => {
      if (!this.deps.isTransportCurrent(generation) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
        this.pollTimer = null
        return
      }
      this.pollTimer = setTimeout(async () => {
        this.pollTimer = null
        await this.poll(generation, false)
        if (this.deps.isTransportCurrent(generation))
          schedulePoll()
      }, this.getPollInterval())
    }

    schedulePoll()
  }

  /**
   * 执行轮询任务
   */
  async poll(generation: number, refreshAfterCurrent = false): Promise<void> {
    if (!this.deps.isTransportCurrent(generation))
      return
    if (this.pollingGeneration !== null) {
      if (refreshAfterCurrent)
        this.refreshAfterCurrentPoll = true
      return
    }

    this.pollingGeneration = generation

    try {
      const now = Date.now()
      const shouldRefreshClients = this.deps.shouldRefreshClients(now)
      if (shouldRefreshClients)
        this.deps.markClientsFetchAttempt(now)

      const signal = this.deps.getTransportSignal()
      const [statusesResult, clientsResult] = await Promise.allSettled([
        this.deps.rpc.getClient().call<Record<string, NodeStatus>>('common:getNodesLatestStatus', undefined, signal),
        shouldRefreshClients
          ? this.deps.fetchClients(signal)
          : Promise.resolve(null),
      ])

      if (!this.deps.isTransportCurrent(generation))
        return

      if (clientsResult.status === 'fulfilled' && clientsResult.value) {
        this.deps.nodesStore.updateNodeClients(clientsResult.value)
        this.deps.markClientsFetched(now)
      }
      else if (clientsResult.status === 'rejected') {
        logAppWarning('Failed to refresh node metadata; keeping previous node data', clientsResult.reason)
      }

      if (statusesResult.status === 'rejected')
        throw statusesResult.reason

      this.deps.nodesStore.updateNodeStatuses(statusesResult.value)

      // 连接恢复正常，重置错误状态
      this.postFailureCount = 0
      this.deps.appStore.connectionError = false
    }
    catch (error) {
      if (!this.deps.isTransportCurrent(generation))
        return

      const nextFailureCount = this.postFailureCount + 1
      if (shouldLogPollingFailure(nextFailureCount)) {
        if (error instanceof RpcError)
          logAppError(`Poll RPC error (${nextFailureCount} consecutive failures)`, error)
        else
          logAppError(`Poll error (${nextFailureCount} consecutive failures)`, error)
      }

      this.postFailureCount = nextFailureCount
      this.deps.appStore.connectionError = this.postFailureCount >= this.deps.config.postFailureThreshold
    }
    finally {
      if (this.pollingGeneration === generation)
        this.pollingGeneration = null
      if (this.refreshAfterCurrentPoll && this.deps.isTransportCurrent(generation)) {
        this.refreshAfterCurrentPoll = false
        void this.poll(generation, false)
      }
    }
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** 会话恢复（revalidateSessionAndTransport）需要的复位：停轮询、清重连计时器、取消 WS 关闭监听，但不清失败计数——那由新一轮 runStartupRequests 的结果决定。 */
  resetForSessionRecovery(): void {
    this.stopPolling()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.useWebSocket = false
  }

  destroy(): void {
    this.stopPolling()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.pollingGeneration = null
    this.refreshAfterCurrentPoll = false
  }
}
