import type { useAppStore } from '@/stores/app'
import type { getSharedApi } from '@/utils/api'
import type { CommitGuard, InitConfig } from '@/utils/init.shared'
import type { KomariRpc } from '@/utils/rpc'
import { KOMARI_ADMIN_SERVERS_PATH } from '@/constants/navigation'
import { createAbortError, linkAbortSignal, waitWithAbort } from '@/utils/init.shared'
import { isRpcPermissionError, RpcError } from '@/utils/rpc'
import { logAppError, logAppWarning } from '@/utils/safeError'

type AppStore = ReturnType<typeof useAppStore>
type ApiClient = ReturnType<typeof getSharedApi>

export async function checkBackendHealth(options: {
  signal: AbortSignal
  canCommit: CommitGuard
  config: Required<InitConfig>
  rpc: KomariRpc
  appStore: AppStore
  navigate: (path: string) => void
  onPrivateSite: () => void
}): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= options.config.healthCheckAttempts; attempt++) {
    const controller = new AbortController()
    const unlinkSignal = linkAbortSignal(controller, options.signal)
    const timeoutId = setTimeout(() => controller.abort(), options.config.healthCheckTimeout)
    try {
      const result = await options.rpc.ping(controller.signal)
      if (!options.canCommit())
        throw createAbortError()
      if (result !== 'pong')
        throw new RpcError(-32000, 'Unexpected health check response')
      return
    }
    catch (error) {
      if (!options.canCommit())
        throw createAbortError()
      if (isRpcPermissionError(error)) {
        console.warn(`[InitManager] Private site detected, redirecting to ${KOMARI_ADMIN_SERVERS_PATH}`)
        options.onPrivateSite()
        options.appStore.updateLoginState(false)
        options.appStore.loading = false
        options.navigate(KOMARI_ADMIN_SERVERS_PATH)
        return
      }
      lastError = error
      if (attempt < options.config.healthCheckAttempts) {
        const retryDelay = options.config.healthCheckRetryInterval * 2 ** (attempt - 1)
        logAppWarning(`Health check attempt ${attempt} failed; retrying in ${retryDelay}ms`, error)
        await waitWithAbort(retryDelay, options.signal)
      }
    }
    finally {
      clearTimeout(timeoutId)
      unlinkSignal()
    }
  }
  if (!options.canCommit())
    throw createAbortError()
  logAppError('Health check failed after retries', lastError)
  throw new Error('Backend service unavailable')
}

export async function fetchInitialPublicSettings(
  api: ApiClient,
  appStore: AppStore,
  signal: AbortSignal,
  canCommit: CommitGuard,
): Promise<void> {
  try {
    const readEpoch = appStore.publicSettingsEpoch ?? 0
    const publicSettings = await api.getPublicSettings(signal)
    if (!canCommit())
      return
    if (typeof appStore.applyFetchedPublicSettings === 'function')
      appStore.applyFetchedPublicSettings(publicSettings, readEpoch)
    else
      appStore.publicSettings = publicSettings
  }
  catch (error) {
    if (!signal.aborted && canCommit())
      logAppError('Failed to fetch public settings', error)
  }
}

export async function fetchInitialUserInfo(
  api: ApiClient,
  appStore: AppStore,
  signal: AbortSignal,
  canCommit: CommitGuard,
): Promise<void> {
  try {
    const user = await api.getMe(signal)
    if (canCommit())
      appStore.updateLoginState(user?.logged_in === true, user)
  }
  catch (error) {
    if (!signal.aborted && canCommit())
      logAppError('Failed to fetch user info', error)
  }
}
