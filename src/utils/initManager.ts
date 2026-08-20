import type { CommitGuard, InitConfig, InitManagerDependencies } from '@/utils/init.shared'
import type { Client, KomariRpc, NodeStatus } from '@/utils/rpc'
import { setManagedThemeSettingsPublisher } from '@/services/theme-settings.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getSharedApi } from '@/utils/api'
import { checkBackendHealth, fetchInitialPublicSettings, fetchInitialUserInfo } from '@/utils/init.bootstrap'
import {
  calculatePollingInterval,
  CLIENTS_REFRESH_INTERVAL_MS,
  DEFAULT_INIT_CONFIG,
  raceWithAbort,
  shouldLogPollingFailure,
} from '@/utils/init.shared'
import { getSharedRpc, RpcError } from '@/utils/rpc'
import { logAppError, logAppWarning } from '@/utils/safeError'

/** 初始化状态管理 */
export class InitManager {
  private config: Required<InitConfig>
  private rpc: KomariRpc
  private appStore: ReturnType<typeof useAppStore>
  private nodesStore: ReturnType<typeof useNodesStore>
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeWsClose: (() => void) | null = null
  private pollingGeneration: number | null = null
  private refreshAfterCurrentPoll = false
  private destroyed = false
  private postFailureCount = 0
  private lastClientsFetchedAt = 0
  private lastClientsFetchAttemptAt = 0
  private clientsRefreshPromise: Promise<Record<string, Client>> | null = null
  private isInitialized = false
  private metadataRefreshListenersAttached = false
  private redirectingToAdmin = false
  private useWebSocket: boolean | null = null // 根据主题配置决定
  private readonly api: ReturnType<typeof getSharedApi>
  private readonly navigate: (path: string) => void
  private lifecycleController = new AbortController()
  private transportController = new AbortController()
  private lifecycleGeneration = 0
  private transportGeneration = 0
  private sessionRecoveryPromise: Promise<void> | null = null
  private readonly handleWindowFocus = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      return
    void this.revalidateSessionAndTransport()
      .catch(error => logAppWarning('Failed to revalidate session on focus', error))
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.handleWindowFocus()
    }
    else {
      this.stopPolling()
    }
  }

  constructor(config: InitConfig = {}, dependencies: InitManagerDependencies = {}) {
    this.config = { ...DEFAULT_INIT_CONFIG, ...config }
    this.rpc = dependencies.rpc ?? getSharedRpc()
    this.appStore = dependencies.appStore ?? useAppStore()
    this.nodesStore = dependencies.nodesStore ?? useNodesStore()
    this.api = dependencies.api ?? getSharedApi()
    this.navigate = dependencies.navigate ?? ((path: string) => {
      location.href = path
    })
    setManagedThemeSettingsPublisher(settings => this.appStore.applyPublicSettings?.(settings))
  }

  private isLifecycleCurrent(generation: number): boolean {
    return !this.destroyed
      && !this.lifecycleController.signal.aborted
      && generation === this.lifecycleGeneration
  }

  private isTransportCurrent(generation: number): boolean {
    return !this.destroyed
      && !this.lifecycleController.signal.aborted
      && !this.transportController.signal.aborted
      && generation === this.transportGeneration
  }

  private getPollInterval(): number {
    return calculatePollingInterval(
      this.appStore.dataUpdateInterval * 1000,
      this.postFailureCount,
      this.config.postMaxRetryInterval,
    )
  }

  async init(): Promise<void> {
    if (this.destroyed || this.lifecycleController.signal.aborted)
      return
    if (this.isInitialized) {
      console.warn('[InitManager] Already initialized')
      return
    }

    const generation = ++this.lifecycleGeneration
    const signal = this.lifecycleController.signal
    const canCommit = () => this.isLifecycleCurrent(generation) && !this.redirectingToAdmin
    try {
      await this.runStartupRequests(signal, canCommit)

      if (!canCommit())
        return

      // 首次数据请求即使失败，也启动实时连接和轮询以便自动恢复。
      this.startWebSocketAndPolling(++this.transportGeneration)
      this.attachMetadataRefreshListeners()
      this.isInitialized = true
    }
    catch (error) {
      if (!this.isLifecycleCurrent(generation))
        return
      logAppError('Initialization failed', error)
      this.appStore.connectionError = true
      throw error
    }
    finally {
      // 即使部分请求失败也解除加载状态，让全局错误提示和公共页面可见。
      if (this.isLifecycleCurrent(generation))
        this.appStore.loading = false
    }
  }

  private async runStartupRequests(signal: AbortSignal, canCommit: CommitGuard): Promise<boolean> {
    const [healthResult, , , nodesResult] = await Promise.allSettled([
      this.healthCheck(signal, canCommit),
      this.fetchPublicSettings(signal, canCommit),
      this.fetchUserInfo(signal, canCommit),
      this.fetchNodesData(signal, canCommit),
    ])

    if (!canCommit())
      return false

    const nodesAvailable = nodesResult.status === 'fulfilled'
    this.appStore.connectionError = !nodesAvailable

    if (nodesAvailable) {
      this.postFailureCount = 0
    }
    else if (healthResult.status === 'rejected') {
      console.error('[InitManager] Backend health check and initial node load both failed')
    }

    return nodesAvailable
  }

  async retry(): Promise<boolean> {
    if (this.destroyed || this.redirectingToAdmin)
      return false
    if (this.isInitialized) {
      await this.revalidateSessionAndTransport()
      return !this.appStore.connectionError
    }

    const generation = this.lifecycleGeneration
    const canCommit = () => this.isLifecycleCurrent(generation) && !this.redirectingToAdmin
    const recovered = await this.runStartupRequests(this.lifecycleController.signal, canCommit)
    if (!this.isInitialized && this.isLifecycleCurrent(generation) && !this.redirectingToAdmin) {
      this.startWebSocketAndPolling(++this.transportGeneration)
      this.attachMetadataRefreshListeners()
      this.isInitialized = true
    }
    return recovered
  }

  private healthCheck(signal: AbortSignal, canCommit: CommitGuard): Promise<void> {
    return checkBackendHealth({
      signal,
      canCommit,
      config: this.config,
      rpc: this.rpc,
      appStore: this.appStore,
      navigate: this.navigate,
      onPrivateSite: () => {
        this.redirectingToAdmin = true
      },
    })
  }

  private fetchPublicSettings(signal: AbortSignal, canCommit: CommitGuard): Promise<void> {
    return fetchInitialPublicSettings(this.api, this.appStore, signal, canCommit)
  }

  private fetchUserInfo(signal: AbortSignal, canCommit: CommitGuard): Promise<void> {
    return fetchInitialUserInfo(this.api, this.appStore, signal, canCommit)
  }

  private async fetchNodesData(signal: AbortSignal, canCommit: CommitGuard): Promise<void> {
    try {
      // 并行获取节点信息和最新状态
      const [clientsResult, statusesResult] = await Promise.all([
        this.fetchClientsSnapshot(signal),
        this.rpc.getClient().call<Record<string, NodeStatus>>('common:getNodesLatestStatus', undefined, signal),
      ])

      if (!canCommit())
        return
      // 初始化节点数据
      this.nodesStore.initNodes(clientsResult, statusesResult)
      this.lastClientsFetchedAt = Date.now()
      this.lastClientsFetchAttemptAt = this.lastClientsFetchedAt
    }
    catch (error) {
      if (signal.aborted || !canCommit())
        return
      logAppError('Failed to fetch nodes data', error)
      throw error
    }
  }

  private fetchClientsSnapshot(signal = this.lifecycleController.signal): Promise<Record<string, Client>> {
    if (this.clientsRefreshPromise)
      return this.clientsRefreshPromise

    const request = this.rpc.getClient().call<Record<string, Client>>('common:getNodes', undefined, signal)
    const trackedRequest = request.finally(() => {
      if (this.clientsRefreshPromise === trackedRequest)
        this.clientsRefreshPromise = null
    })
    this.clientsRefreshPromise = trackedRequest
    return trackedRequest
  }

  async refreshNodeClients(): Promise<void> {
    if (this.destroyed || this.redirectingToAdmin)
      return

    const generation = this.transportGeneration
    this.lastClientsFetchAttemptAt = Date.now()
    const clients = await this.fetchClientsSnapshot(this.transportController.signal)
    if (!this.isTransportCurrent(generation))
      return
    this.nodesStore.updateNodeClients(clients)
    this.lastClientsFetchedAt = Date.now()
    this.lastClientsFetchAttemptAt = this.lastClientsFetchedAt
  }

  /**
   * A browser can keep an authenticated WebSocket alive while the HTTP session
   * expires or is revoked. Always tear down that transport before accepting
   * data after focus/visibility resume, then rebuild it only after fresh HTTP
   * settings, session and node responses have committed.
   */
  private revalidateSessionAndTransport(): Promise<void> {
    if (this.destroyed || this.redirectingToAdmin)
      return Promise.resolve()
    if (this.sessionRecoveryPromise)
      return this.sessionRecoveryPromise

    const recovery = this.runSessionRecovery().finally(() => {
      if (this.sessionRecoveryPromise === recovery)
        this.sessionRecoveryPromise = null
    })
    this.sessionRecoveryPromise = recovery
    return recovery
  }

  private async runSessionRecovery(): Promise<void> {
    const generation = ++this.transportGeneration
    this.transportController.abort()
    this.transportController = new AbortController()
    const signal = this.transportController.signal

    this.stopPolling()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.useWebSocket = false
    this.clientsRefreshPromise = null
    this.lastClientsFetchAttemptAt = 0
    this.refreshAfterCurrentPoll = false

    const client = this.rpc.getClient()
    client.setTransport(false)
    client.close()
    this.nodesStore.updateWsState('disconnected', 0)

    const lifecycleGeneration = this.lifecycleGeneration
    const canCommit = () => this.isLifecycleCurrent(lifecycleGeneration)
      && this.isTransportCurrent(generation)
      && !signal.aborted
      && !this.redirectingToAdmin
    const recovered = await this.runStartupRequests(signal, canCommit)
    if (!canCommit())
      return

    this.appStore.connectionError = !recovered
    this.startWebSocketAndPolling(generation)
  }

  private attachMetadataRefreshListeners(): void {
    if (this.metadataRefreshListenersAttached)
      return
    window.addEventListener('focus', this.handleWindowFocus)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.metadataRefreshListenersAttached = true
  }

  private detachMetadataRefreshListeners(): void {
    if (!this.metadataRefreshListenersAttached)
      return
    window.removeEventListener('focus', this.handleWindowFocus)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.metadataRefreshListenersAttached = false
  }

  private startWebSocketAndPolling(generation = this.transportGeneration): void {
    if (!this.isTransportCurrent(generation))
      return
    // 根据主题配置决定初始连接模式
    const configuredMode = this.appStore.rpcTransportMode
    this.useWebSocket = configuredMode === 'websocket'

    if (this.useWebSocket) {
      // 尝试建立 WebSocket 连接
      void this.connectWebSocket(generation)
    }
    else {
      // HTTP 模式：直接设置 RPC 客户端为 HTTP 模式
      const client = this.rpc.getClient()
      client.setTransport(false)
      this.nodesStore.updateWsState('disconnected', this.config.wsMaxReconnectAttempts)
    }

    // 开始轮询（作为 WebSocket 的补充或备选方案）
    this.startPolling(generation)
  }

  private async connectWebSocket(generation = this.transportGeneration): Promise<void> {
    // 如果已回落到 POST 模式或配置为 HTTP 模式，不再尝试 WebSocket
    if (!this.isTransportCurrent(generation) || this.useWebSocket === false) {
      return
    }

    const client = this.rpc.getClient()

    // 切换到 WebSocket 模式
    client.setTransport(true)
    this.nodesStore.updateWsState('connecting', this.nodesStore.wsReconnectAttempts)

    try {
      // 使用 ping 验证连接，10 秒超时
      await raceWithAbort(client.ensureWebSocketConnectedWithPing(10000), this.transportController.signal)
      if (!this.isTransportCurrent(generation) || !this.useWebSocket) {
        client.close()
        return
      }
      this.nodesStore.updateWsState('connected', 0)

      // 连接成功，重置错误状态
      this.appStore.connectionError = false

      // 监听连接状态变化
      this.monitorWebSocketConnection(generation)
    }
    catch (error) {
      if (!this.isTransportCurrent(generation) || !this.useWebSocket)
        return
      logAppError('WebSocket connection failed', error)
      this.nodesStore.updateWsState('disconnected')
      this.scheduleReconnect(generation)
    }
  }

  /**
   * 监控 WebSocket 连接状态
   */
  private monitorWebSocketConnection(generation: number): void {
    this.unsubscribeWsClose?.()
    const client = this.rpc.getClient()
    this.unsubscribeWsClose = client.onWebSocketClose(() => {
      if (!this.isTransportCurrent(generation))
        return
      // 如果当前是已连接状态且还在使用 WebSocket 模式，触发重连
      if (this.useWebSocket === true && this.nodesStore.wsConnectionState === 'connected') {
        this.nodesStore.updateWsState('disconnected')
        this.scheduleReconnect(generation)
      }
    })
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(generation = this.transportGeneration): void {
    if (!this.isTransportCurrent(generation) || this.useWebSocket === false || this.reconnectTimer)
      return

    const attempts = this.nodesStore.wsReconnectAttempts

    // 达到最大重连次数，回落到 POST 模式
    if (attempts >= this.config.wsMaxReconnectAttempts) {
      console.error('[InitManager] Max reconnect attempts reached, falling back to POST mode')
      this.fallbackToPostMode(generation)
      return
    }

    // 首次失败时显示提示
    if (attempts === 0) {
      window.$message?.error('WebSocket 建立失败，正在尝试重连。')
    }

    const nextAttempts = attempts + 1
    this.nodesStore.updateWsState('reconnecting', nextAttempts)
    const backoff = Math.min(this.config.wsReconnectInterval * 2 ** Math.max(0, nextAttempts - 1), 30_000)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        const client = this.rpc.getClient()
        client.close()
        await this.connectWebSocket(generation)
      }
      catch (error) {
        if (!this.isTransportCurrent(generation))
          return
        logAppError('WebSocket reconnect failed', error)
        this.scheduleReconnect(generation)
      }
    }, backoff)
  }

  /**
   * 回落到 POST 模式
   */
  private fallbackToPostMode(generation = this.transportGeneration): void {
    if (!this.isTransportCurrent(generation))
      return
    this.useWebSocket = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.nodesStore.updateWsState('disconnected', this.config.wsMaxReconnectAttempts)

    // 关闭 WebSocket 连接
    const client = this.rpc.getClient()
    client.setTransport(false)
    client.close()

    // 显示提示
    window.$message?.warning('WebSocket 无法连接，尝试回落 POST 模式。')
  }

  /**
   * 开始轮询
   */
  private startPolling(generation = this.transportGeneration): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }

    if (!this.isTransportCurrent(generation) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      this.pollTimer = null
      return
    }

    const schedulePoll = () => {
      if (!this.isTransportCurrent(generation) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
        this.pollTimer = null
        return
      }
      this.pollTimer = setTimeout(async () => {
        this.pollTimer = null
        await this.poll(false, generation)
        if (this.isTransportCurrent(generation))
          schedulePoll()
      }, this.getPollInterval())
    }

    schedulePoll()
  }

  /**
   * 执行轮询任务
   */
  private async poll(refreshAfterCurrent = false, generation = this.transportGeneration): Promise<void> {
    if (!this.isTransportCurrent(generation))
      return
    if (this.pollingGeneration !== null) {
      if (refreshAfterCurrent)
        this.refreshAfterCurrentPoll = true
      return
    }

    this.pollingGeneration = generation

    try {
      const now = Date.now()
      const lastClientsRequestAt = Math.max(this.lastClientsFetchedAt, this.lastClientsFetchAttemptAt)
      const shouldRefreshClients = now - lastClientsRequestAt >= CLIENTS_REFRESH_INTERVAL_MS
      if (shouldRefreshClients)
        this.lastClientsFetchAttemptAt = now

      const [statusesResult, clientsResult] = await Promise.allSettled([
        this.rpc.getClient().call<Record<string, NodeStatus>>('common:getNodesLatestStatus', undefined, this.transportController.signal),
        shouldRefreshClients
          ? this.fetchClientsSnapshot(this.transportController.signal)
          : Promise.resolve(null),
      ])

      if (!this.isTransportCurrent(generation))
        return

      if (clientsResult.status === 'fulfilled' && clientsResult.value) {
        this.nodesStore.updateNodeClients(clientsResult.value)
        this.lastClientsFetchedAt = now
      }
      else if (clientsResult.status === 'rejected') {
        logAppWarning('Failed to refresh node metadata; keeping previous node data', clientsResult.reason)
      }

      if (statusesResult.status === 'rejected')
        throw statusesResult.reason

      this.nodesStore.updateNodeStatuses(statusesResult.value)

      // 连接恢复正常，重置错误状态
      this.postFailureCount = 0
      this.appStore.connectionError = false
    }
    catch (error) {
      if (!this.isTransportCurrent(generation))
        return

      const nextFailureCount = this.postFailureCount + 1
      if (shouldLogPollingFailure(nextFailureCount)) {
        if (error instanceof RpcError)
          logAppError(`Poll RPC error (${nextFailureCount} consecutive failures)`, error)
        else
          logAppError(`Poll error (${nextFailureCount} consecutive failures)`, error)
      }

      this.postFailureCount = nextFailureCount
      this.appStore.connectionError = this.postFailureCount >= this.config.postFailureThreshold
    }
    finally {
      if (this.pollingGeneration === generation)
        this.pollingGeneration = null
      if (this.refreshAfterCurrentPoll && this.isTransportCurrent(generation)) {
        this.refreshAfterCurrentPoll = false
        void this.poll(false, generation)
      }
    }
  }

  /**
   * 停止轮询
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    if (this.destroyed)
      return
    this.destroyed = true
    this.lifecycleGeneration += 1
    this.transportGeneration += 1
    this.lifecycleController.abort()
    this.transportController.abort()
    this.stopPolling()
    this.detachMetadataRefreshListeners()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeWsClose?.()
    this.unsubscribeWsClose = null
    this.rpc.close()
    this.clientsRefreshPromise = null
    this.sessionRecoveryPromise = null
    this.pollingGeneration = null
    this.refreshAfterCurrentPoll = false
    this.nodesStore.clearNodes()
    this.isInitialized = false
    setManagedThemeSettingsPublisher()
  }
}
