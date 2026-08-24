import type { MaybeRefOrGetter } from 'vue'
import type { PermissionKey } from '@/services/auth.service'
import type { StatusRecord } from '@/utils/rpc'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { LOAD_CONFIG, LOAD_RECORD_MAX_COUNT } from '@/constants/load'
import { SharedCache } from '@/services/cache.service'
import { buildRecordsByClient, loadLoadRecords, loadNodeLoadRecords } from '@/services/history.service'
import { analyzeDiskPrediction, buildDiskPrediction } from '@/services/prediction.service'
import { useAppStore } from '@/stores/app'

export { analyzeDiskPrediction, buildDiskPrediction, loadNodeLoadRecords }
export type { DiskPredictionState, NodeDiskPrediction } from '@/services/prediction.service'

interface SharedLoadRecordsState {
  recordsByClient: Map<string, StatusRecord[]>
}

interface SharedLoadRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedLoadRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  controller: AbortController | null
  nodePromises: Map<string, Promise<StatusRecord[]>>
  nodeControllers: Map<string, AbortController>
  nodeFetchedAt: Map<string, number>
  subscribers: number
  lastFetchedAt: number
  fullLoadUnavailable: boolean
  fullLoadRetryAt: number
}

const LOAD_RECORD_REFRESH_INTERVAL_MS = LOAD_CONFIG.records.refreshInterval
const sharedLoadRecordsCache = new SharedCache<SharedLoadRecordsEntry>({
  maxSize: CACHE_CONFIG.loadRecords.maxSize,
  ttl: CACHE_CONFIG.loadRecords.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
  canEvict: entry => entry.subscribers === 0 && entry.promise === null && entry.nodePromises.size === 0,
})
const zeroSampleWarningKeys = new Set<string>()
const sharedLoadRefreshEntries = new Map<string, {
  entry: SharedLoadRecordsEntry
  hours: number
  maxCount?: number
}>()
let sharedLoadRefreshTimer: ReturnType<typeof setInterval> | null = null
let sharedLoadVisibilityListenerAttached = false

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

function getSharedLoadRecordsKey(hours: number, maxCount?: number): string {
  return `${hours}:${maxCount ?? 'all'}`
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function createSharedLoadRecordsEntry(): SharedLoadRecordsEntry {
  return {
    data: shallowRef<SharedLoadRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    controller: null,
    nodePromises: new Map<string, Promise<StatusRecord[]>>(),
    nodeControllers: new Map<string, AbortController>(),
    nodeFetchedAt: new Map<string, number>(),
    subscribers: 0,
    lastFetchedAt: 0,
    fullLoadUnavailable: false,
    fullLoadRetryAt: 0,
  }
}

function getSharedLoadRecordsEntry(key: string): SharedLoadRecordsEntry {
  const cachedEntry = sharedLoadRecordsCache.get(key)
  if (cachedEntry)
    return cachedEntry

  const nextEntry = createSharedLoadRecordsEntry()
  return sharedLoadRecordsCache.set(key, nextEntry)
}

function setNodeRecords(entry: SharedLoadRecordsEntry, uuid: string, records: StatusRecord[]): void {
  const current = entry.data.value?.recordsByClient ?? new Map<string, StatusRecord[]>()
  const next = new Map(current)
  next.set(uuid, records)
  entry.data.value = { recordsByClient: next }
  entry.nodeFetchedAt.set(uuid, Date.now())
}

function warnZeroSamplesIfNeeded(entry: SharedLoadRecordsEntry, uuid: string, cacheKey: string, online: boolean, maxCount?: number): void {
  if (!import.meta.env.DEV || !online || maxCount !== LOAD_RECORD_MAX_COUNT || entry.fullLoadUnavailable)
    return

  const records = entry.data.value?.recordsByClient.get(uuid)
  if (records && records.length > 0)
    return

  const warningKey = `${cacheKey}:${uuid}`
  if (zeroSampleWarningKeys.has(warningKey))
    return

  zeroSampleWarningKeys.add(warningKey)
  console.warn(`[Transit] capped shared load history returned zero samples for online node ${uuid}; maxCount=${LOAD_RECORD_MAX_COUNT}. This may indicate cap starvation or missing backend history.`)
}

async function loadNodeRecordsIntoEntry(entry: SharedLoadRecordsEntry, uuid: string, hours: number, maxCount?: number): Promise<StatusRecord[]> {
  const existingPromise = entry.nodePromises.get(uuid)
  if (existingPromise) {
    const existingController = entry.nodeControllers.get(uuid)
    if (!existingController?.signal.aborted)
      return existingPromise
    await existingPromise.catch(() => {})
    return loadNodeRecordsIntoEntry(entry, uuid, hours, maxCount)
  }

  const controller = new AbortController()
  entry.nodeControllers.set(uuid, controller)
  const promise = loadNodeLoadRecords(uuid, hours, maxCount, controller.signal)
    .then((records) => {
      setNodeRecords(entry, uuid, records)
      return records
    })
    .catch((error) => {
      if (entry.nodePromises.get(uuid) === promise)
        entry.nodePromises.delete(uuid)
      throw error
    })
    .finally(() => {
      if (entry.nodePromises.get(uuid) === promise)
        entry.nodePromises.delete(uuid)
      if (entry.nodeControllers.get(uuid) === controller)
        entry.nodeControllers.delete(uuid)
    })

  entry.nodePromises.set(uuid, promise)
  return promise
}

async function loadSharedLoadRecords(entry: SharedLoadRecordsEntry, hours: number, maxCount?: number): Promise<void> {
  const now = Date.now()
  if (entry.fullLoadUnavailable && now < entry.fullLoadRetryAt)
    return
  if (entry.promise) {
    if (!entry.controller?.signal.aborted)
      return entry.promise
    await entry.promise.catch(() => {})
    return loadSharedLoadRecords(entry, hours, maxCount)
  }

  entry.loading.value = true
  entry.error.value = null
  const controller = new AbortController()
  entry.controller = controller

  let promise: Promise<void> | null = null
  promise = (async () => {
    try {
      const records = await loadLoadRecords(undefined, hours, maxCount, controller.signal)
      entry.data.value = {
        recordsByClient: buildRecordsByClient(records),
      }
      entry.lastFetchedAt = Date.now()
      entry.fullLoadUnavailable = false
      entry.fullLoadRetryAt = 0
    }
    catch (err) {
      if (isAbortError(err))
        throw err

      entry.fullLoadUnavailable = true
      entry.fullLoadRetryAt = Date.now() + LOAD_RECORD_REFRESH_INTERVAL_MS
      entry.error.value = err instanceof Error ? err.message : '获取负载历史失败'
    }
    finally {
      entry.loading.value = false
      if (entry.promise === promise)
        entry.promise = null
      if (entry.controller === controller)
        entry.controller = null
      sharedLoadRecordsCache.sweep()
    }
  })()

  entry.promise = promise

  return promise
}

function refreshSharedLoadRecords(): void {
  if (!pageIsVisible())
    return
  for (const { entry, hours, maxCount } of sharedLoadRefreshEntries.values())
    void loadSharedLoadRecords(entry, hours, maxCount).catch(() => {})
}

function handleSharedLoadVisibilityChange(): void {
  if (pageIsVisible())
    refreshSharedLoadRecords()
}

function startSharedLoadRecordsRefresh(key: string, entry: SharedLoadRecordsEntry, hours: number, maxCount?: number): void {
  sharedLoadRefreshEntries.set(key, { entry, hours, maxCount })
  if (sharedLoadRefreshTimer || typeof window === 'undefined')
    return
  sharedLoadRefreshTimer = window.setInterval(refreshSharedLoadRecords, LOAD_RECORD_REFRESH_INTERVAL_MS)
  if (!sharedLoadVisibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleSharedLoadVisibilityChange)
    sharedLoadVisibilityListenerAttached = true
  }
}

function stopSharedLoadRecordsRefresh(key: string): void {
  sharedLoadRefreshEntries.delete(key)
  if (sharedLoadRefreshEntries.size > 0)
    return
  if (sharedLoadRefreshTimer) {
    clearInterval(sharedLoadRefreshTimer)
    sharedLoadRefreshTimer = null
  }
  if (sharedLoadVisibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleSharedLoadVisibilityChange)
    sharedLoadVisibilityListenerAttached = false
  }
}

function abortSharedLoadRecordsEntry(entry: SharedLoadRecordsEntry): void {
  entry.controller?.abort()
  for (const controller of entry.nodeControllers.values())
    controller.abort()
}

function retainSharedLoadRecordsEntry(hours: number, maxCount?: number): () => void {
  const key = getSharedLoadRecordsKey(hours, maxCount)
  const entry = getSharedLoadRecordsEntry(key)
  entry.subscribers += 1
  startSharedLoadRecordsRefresh(key, entry, hours, maxCount)

  let released = false
  return () => {
    if (released)
      return

    released = true
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0) {
      stopSharedLoadRecordsRefresh(key)
      abortSharedLoadRecordsEntry(entry)
      sharedLoadRecordsCache.sweep()
    }
  }
}

export async function loadSharedNodeLoadRecords(hours: number, maxCount: number | undefined = LOAD_RECORD_MAX_COUNT): Promise<Map<string, StatusRecord[]>> {
  const safeHours = Math.max(1, Math.floor(hours))
  const safeMaxCount = normalizeMaxCount(maxCount)
  const entry = getSharedLoadRecordsEntry(getSharedLoadRecordsKey(safeHours, safeMaxCount))
  // This imperative reader is also a consumer. Count it while awaiting so a
  // component unmount cannot abort the shared source out from under it.
  entry.subscribers += 1
  try {
    const shouldLoadRecords = !entry.data.value
      || Date.now() - entry.lastFetchedAt >= LOAD_RECORD_REFRESH_INTERVAL_MS

    if (shouldLoadRecords)
      await loadSharedLoadRecords(entry, safeHours, safeMaxCount)

    return entry.data.value?.recordsByClient ?? new Map<string, StatusRecord[]>()
  }
  finally {
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    sharedLoadRecordsCache.sweep()
  }
}

export function useNodeLoadStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    diskTotal?: MaybeRefOrGetter<number>
    maxCount?: MaybeRefOrGetter<number | undefined>
    online?: MaybeRefOrGetter<boolean>
    permission?: PermissionKey
  },
) {
  const appStore = useAppStore()
  const loading = ref(false)
  const error = ref<string | null>(null)
  const recordsAllowed = ref(false)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? LOAD_RECORD_MAX_COUNT)
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedLoadRecordsKey(hours, maxCount),
      enabled: toValue(options?.enabled) ?? true,
      online: toValue(options?.online) ?? false,
      authStatus: appStore.authStatus,
      diskTotal: Math.max(0, toValue(options?.diskTotal) ?? 0),
    }
  })

  let activeCacheKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null
  let permissionVerified = false

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number): void {
    const cacheKey = hours === null ? null : getSharedLoadRecordsKey(hours, maxCount)
    if (activeCacheKey === cacheKey)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeCacheKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedLoadRecordsEntry(hours, maxCount)
    activeCacheKey = cacheKey
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  const records = computed<StatusRecord[]>(() => {
    const { uuid: nodeUuid, cacheKey, enabled } = resolved.value
    if (!enabled || !recordsAllowed.value || !nodeUuid.trim())
      return []

    const entry = getSharedLoadRecordsEntry(cacheKey)
    return entry.data.value?.recordsByClient.get(nodeUuid) ?? []
  })

  const diskPredictionState = computed(() => analyzeDiskPrediction(records.value, resolved.value.diskTotal))
  const diskPrediction = computed(() => diskPredictionState.value.prediction)

  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, cacheKey, enabled, online, authStatus } = next
      if (!enabled || !nodeUuid.trim()) {
        recordsAllowed.value = false
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      if (options?.permission) {
        if (authStatus !== 'authenticated')
          permissionVerified = false

        if (!permissionVerified) {
          const granted = await appStore.requireLoginPermission(options.permission, { force: false })
          if (cancelled)
            return
          permissionVerified = granted
          recordsAllowed.value = granted
          if (!granted) {
            syncSharedRecordsSubscription(null)
            loading.value = false
            error.value = null
            return
          }
        }
      }
      else {
        recordsAllowed.value = true
      }

      syncSharedRecordsSubscription(hours, maxCount)
      const entry = getSharedLoadRecordsEntry(cacheKey)
      const shouldLoadRecords = !entry.data.value
        || Date.now() - entry.lastFetchedAt >= LOAD_RECORD_REFRESH_INTERVAL_MS

      if (!shouldLoadRecords) {
        loading.value = false
        error.value = null
        return
      }

      loading.value = !entry.data.value
      error.value = null

      try {
        await loadSharedLoadRecords(entry, hours, maxCount)
        if (!cancelled)
          warnZeroSamplesIfNeeded(entry, nodeUuid, cacheKey, online, maxCount)
        if (!cancelled && entry.fullLoadUnavailable) {
          const nodeFetchedAt = entry.nodeFetchedAt.get(nodeUuid) ?? 0
          const shouldLoadNodeRecords = !entry.data.value?.recordsByClient.has(nodeUuid)
            || Date.now() - nodeFetchedAt >= LOAD_RECORD_REFRESH_INTERVAL_MS
          if (shouldLoadNodeRecords)
            await loadNodeRecordsIntoEntry(entry, nodeUuid, hours, maxCount)
        }
      }
      catch (err) {
        if (!cancelled)
          error.value = err instanceof Error ? err.message : '获取负载历史失败'
      }
      finally {
        if (!cancelled)
          loading.value = false
      }
    },
    { immediate: true },
  )

  return {
    records,
    loading,
    error,
    diskPrediction,
    diskPredictionState,
    hasData: computed(() => records.value.length > 0),
  }
}
