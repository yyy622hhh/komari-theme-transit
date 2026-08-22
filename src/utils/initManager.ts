import type { CommitGuard, InitConfig, InitManagerDependencies } from '@/utils/init.shared'
import type { Client, KomariRpc, NodeStatus } from '@/utils/rpc'
import { setManagedThemeSettingsPublisher } from '@/services/theme-settings.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getSharedApi } from '@/utils/api'
import { checkBackendHealth, fetchInitialPublicSettings, fetchInitialUserInfo } from '@/utils/init.bootstrap'
import { CLIENTS_REFRESH_INTERVAL_MS, DEFAULT_INIT_CONFIG } from '@/utils/init.shared'
import { TransportManager } from '@/utils/init.transport'
import { getSharedRpc } from '@/utils/rpc'
import { logAppError, logAppWarning } from '@/utils/safeError'

/** 初始化状态管理 */
export class InitManager {
  private config: Required<InitConfig>
  private rpc: KomariRpc
  private appStore: ReturnType<typeof useAppStore>
  private nodesStore: ReturnType<typeof useNodesStore>
  private readonly transport: TransportManager
  private destroyed = false
  private lastClientsFetchedAt = 0
  private lastClientsFetchAttemptAt = 0
  private clientsRefreshPromise: Promise<Record<string, Client>> | null = null
  private isInitialized = false
  private metadataRefreshListenersAttached = false
  private redirectingToAdmin = false
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
    this.transport = new TransportManager({
      rpc: this.rpc,
      appStore: this.appStore,
      nodesStore: this.nodesStore,
      config: this.config,
      isTransportCurrent: generation => this.isTransportCurrent(generation),
      getTransportSignal: () => this.transportController.signal,
      shouldRefreshClients: (now) => {
        const lastClientsRequestAt = Math.max(this.lastClientsFetchedAt, this.lastClientsFetchAttemptAt)
        return now - lastClientsRequestAt >= CLIENTS_REFRESH_INTERVAL_MS
      },
      markClientsFetchAttempt: (now) => {
        this.lastClientsFetchAttemptAt = now
      },
      fetchClients: signal => this.fetchClientsSnapshot(signal),
      markClientsFetched: (now) => {
        this.lastClientsFetchedAt = now
        this.lastClientsFetchAttemptAt = now
      },
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
      this.transport.start(++this.transportGeneration)
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
      this.transport.resetFailureCount()
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
      this.transport.start(++this.transportGeneration)
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

    this.transport.resetForSessionRecovery()
    this.clientsRefreshPromise = null
    this.lastClientsFetchAttemptAt = 0

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
    this.transport.start(generation)
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

  /**
   * 停止轮询
   */
  stopPolling(): void {
    this.transport.stopPolling()
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
    this.transport.destroy()
    this.detachMetadataRefreshListeners()
    this.rpc.close()
    this.clientsRefreshPromise = null
    this.sessionRecoveryPromise = null
    this.nodesStore.clearNodes()
    this.isInitialized = false
    setManagedThemeSettingsPublisher()
  }
}
