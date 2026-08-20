import type { useAppStore } from '@/stores/app'
import type { useNodesStore } from '@/stores/nodes'
import type { getSharedApi } from '@/utils/api'
import type { KomariRpc } from '@/utils/rpc'
import { REALTIME_CONFIG } from '@/constants/realtime'

export interface InitConfig {
  wsReconnectInterval?: number
  wsMaxReconnectAttempts?: number
  healthCheckTimeout?: number
  healthCheckAttempts?: number
  healthCheckRetryInterval?: number
  postFailureThreshold?: number
  postMaxRetryInterval?: number
}

export interface InitManagerDependencies {
  appStore?: ReturnType<typeof useAppStore>
  nodesStore?: ReturnType<typeof useNodesStore>
  rpc?: KomariRpc
  api?: ReturnType<typeof getSharedApi>
  navigate?: (path: string) => void
}

export type CommitGuard = () => boolean

export const DEFAULT_INIT_CONFIG: Required<InitConfig> = {
  wsReconnectInterval: REALTIME_CONFIG.websocket.reconnectInterval,
  wsMaxReconnectAttempts: REALTIME_CONFIG.websocket.maxReconnectAttempts,
  healthCheckTimeout: REALTIME_CONFIG.websocket.healthCheckTimeout,
  healthCheckAttempts: REALTIME_CONFIG.websocket.healthCheckAttempts,
  healthCheckRetryInterval: REALTIME_CONFIG.websocket.healthCheckRetryInterval,
  postFailureThreshold: REALTIME_CONFIG.polling.postFailureThreshold,
  postMaxRetryInterval: REALTIME_CONFIG.polling.maxRetryInterval,
}

export const CLIENTS_REFRESH_INTERVAL_MS = REALTIME_CONFIG.polling.clientsRefreshInterval

export function calculatePollingInterval(baseIntervalMs: number, failureCount: number, maxRetryIntervalMs: number): number {
  const normalizedBase = Math.max(1, Math.floor(baseIntervalMs))
  const normalizedFailures = Math.max(0, Math.floor(failureCount))
  const normalizedMaximum = Math.max(normalizedBase, Math.floor(maxRetryIntervalMs))
  const exponent = Math.min(normalizedFailures, 16)
  return Math.min(normalizedBase * 2 ** exponent, normalizedMaximum)
}

export function shouldLogPollingFailure(failureCount: number): boolean {
  const normalized = Math.max(0, Math.floor(failureCount))
  return normalized > 0 && (normalized & (normalized - 1)) === 0
}

export function createAbortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(createAbortError())
  let abort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(createAbortError())
    signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', abort))
}

export function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timeoutId)
      reject(createAbortError())
    }
    timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function linkAbortSignal(controller: AbortController, signal: AbortSignal): () => void {
  const abort = () => controller.abort()
  if (signal.aborted) {
    abort()
    return () => {}
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}
