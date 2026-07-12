import type { MaybeRefOrGetter } from 'vue'
import type { StatusRecord } from '@/utils/rpc'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { getSharedApi } from '@/utils/api'
import { getSharedRpc } from '@/utils/rpc'

export interface NodeDiskPrediction {
  daysUntilFull: number
  dailyGrowthBytes: number
  currentDiskBytes: number
  diskTotalBytes: number
  sampleDays: number
  confidence: number
}

interface SharedLoadRecordsState {
  recordsByClient: Map<string, StatusRecord[]>
}

interface SharedLoadRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedLoadRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  nodePromises: Map<string, Promise<StatusRecord[]>>
  nodeFetchedAt: Map<string, number>
  refreshTimer: ReturnType<typeof setInterval> | null
  subscribers: number
  lastFetchedAt: number
  fullLoadUnavailable: boolean
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MIN_DISK_PREDICTION_SAMPLE_DAYS = 2
const LOAD_RECORD_REFRESH_INTERVAL_MS = 5 * 60_000
const sharedLoadRecordsCache = new Map<number, SharedLoadRecordsEntry>()

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeStatusRecord(record: Partial<StatusRecord>): StatusRecord | null {
  if (!record.client || !record.time)
    return null

  return {
    client: record.client,
    time: record.time,
    cpu: numberOrZero(record.cpu),
    gpu: numberOrZero(record.gpu),
    ram: numberOrZero(record.ram),
    ram_total: numberOrZero(record.ram_total),
    swap: numberOrZero(record.swap),
    swap_total: numberOrZero(record.swap_total),
    load: numberOrZero(record.load),
    load5: numberOrZero(record.load5 ?? record.load),
    load15: numberOrZero(record.load15 ?? record.load5 ?? record.load),
    temp: numberOrZero(record.temp),
    disk: numberOrZero(record.disk),
    disk_total: numberOrZero(record.disk_total),
    net_in: numberOrZero(record.net_in),
    net_out: numberOrZero(record.net_out),
    net_total_up: numberOrZero(record.net_total_up),
    net_total_down: numberOrZero(record.net_total_down),
    process: numberOrZero(record.process),
    connections: numberOrZero(record.connections),
    connections_udp: numberOrZero(record.connections_udp),
  }
}

function normalizeStatusRecords(records: Array<Partial<StatusRecord>> | undefined): StatusRecord[] {
  return (records ?? [])
    .map(normalizeStatusRecord)
    .filter((record): record is StatusRecord => Boolean(record))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function createSharedLoadRecordsEntry(): SharedLoadRecordsEntry {
  return {
    data: shallowRef<SharedLoadRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    nodePromises: new Map<string, Promise<StatusRecord[]>>(),
    nodeFetchedAt: new Map<string, number>(),
    refreshTimer: null,
    subscribers: 0,
    lastFetchedAt: 0,
    fullLoadUnavailable: false,
  }
}

function getSharedLoadRecordsEntry(hours: number): SharedLoadRecordsEntry {
  const cachedEntry = sharedLoadRecordsCache.get(hours)
  if (cachedEntry)
    return cachedEntry

  const nextEntry = createSharedLoadRecordsEntry()
  sharedLoadRecordsCache.set(hours, nextEntry)
  return nextEntry
}

function buildRecordsByClient(records: StatusRecord[]): Map<string, StatusRecord[]> {
  const grouped = new Map<string, StatusRecord[]>()
  for (const record of records) {
    const clientRecords = grouped.get(record.client) ?? []
    clientRecords.push(record)
    grouped.set(record.client, clientRecords)
  }
  return grouped
}

async function fetchLoadRecordsByRpc(uuid: string | undefined, hours: number): Promise<StatusRecord[]> {
  const result = await getSharedRpc().getLoadRecords(uuid, hours)
  return normalizeStatusRecords(result.records)
}

export async function loadNodeLoadRecords(uuid: string, hours: number): Promise<StatusRecord[]> {
  try {
    return await fetchLoadRecordsByRpc(uuid, hours)
  }
  catch {
    const result = await getSharedApi().getLoadRecords(uuid, hours)
    return normalizeStatusRecords(result.records)
  }
}

function setNodeRecords(entry: SharedLoadRecordsEntry, uuid: string, records: StatusRecord[]): void {
  const current = entry.data.value?.recordsByClient ?? new Map<string, StatusRecord[]>()
  const next = new Map(current)
  next.set(uuid, records)
  entry.data.value = { recordsByClient: next }
  entry.nodeFetchedAt.set(uuid, Date.now())
}

async function loadNodeRecordsIntoEntry(entry: SharedLoadRecordsEntry, uuid: string, hours: number): Promise<StatusRecord[]> {
  const existingPromise = entry.nodePromises.get(uuid)
  if (existingPromise)
    return existingPromise

  const promise = loadNodeLoadRecords(uuid, hours)
    .then((records) => {
      setNodeRecords(entry, uuid, records)
      return records
    })
    .finally(() => {
      entry.nodePromises.delete(uuid)
    })

  entry.nodePromises.set(uuid, promise)
  return promise
}

async function loadSharedLoadRecords(entry: SharedLoadRecordsEntry, hours: number): Promise<void> {
  if (entry.fullLoadUnavailable)
    return
  if (entry.promise)
    return entry.promise

  entry.loading.value = true
  entry.error.value = null

  entry.promise = (async () => {
    try {
      const records = await fetchLoadRecordsByRpc(undefined, hours)
      entry.data.value = {
        recordsByClient: buildRecordsByClient(records),
      }
      entry.lastFetchedAt = Date.now()
    }
    catch (err) {
      entry.fullLoadUnavailable = true
      entry.error.value = err instanceof Error ? err.message : '获取负载历史失败'
    }
    finally {
      entry.loading.value = false
      entry.promise = null
    }
  })()

  return entry.promise
}

function startSharedLoadRecordsRefresh(entry: SharedLoadRecordsEntry, hours: number): void {
  if (entry.refreshTimer)
    return

  entry.refreshTimer = setInterval(() => {
    void loadSharedLoadRecords(entry, hours).catch(() => {})
  }, LOAD_RECORD_REFRESH_INTERVAL_MS)
}

function stopSharedLoadRecordsRefresh(entry: SharedLoadRecordsEntry): void {
  if (!entry.refreshTimer)
    return

  clearInterval(entry.refreshTimer)
  entry.refreshTimer = null
}

function retainSharedLoadRecordsEntry(hours: number): () => void {
  const entry = getSharedLoadRecordsEntry(hours)
  entry.subscribers += 1
  startSharedLoadRecordsRefresh(entry, hours)

  let released = false
  return () => {
    if (released)
      return

    released = true
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0)
      stopSharedLoadRecordsRefresh(entry)
  }
}

export async function loadSharedNodeLoadRecords(hours: number): Promise<Map<string, StatusRecord[]>> {
  const safeHours = Math.max(1, Math.floor(hours))
  const entry = getSharedLoadRecordsEntry(safeHours)
  const shouldLoadRecords = !entry.data.value
    || Date.now() - entry.lastFetchedAt >= LOAD_RECORD_REFRESH_INTERVAL_MS

  if (shouldLoadRecords)
    await loadSharedLoadRecords(entry, safeHours)

  return entry.data.value?.recordsByClient ?? new Map<string, StatusRecord[]>()
}

export function buildDiskPrediction(records: readonly StatusRecord[], fallbackDiskTotal = 0): NodeDiskPrediction | null {
  const samples = records
    .map((record) => {
      const timestamp = new Date(record.time).getTime()
      const disk = numberOrZero(record.disk)
      const diskTotal = numberOrZero(record.disk_total) || fallbackDiskTotal
      return { timestamp, disk, diskTotal }
    })
    .filter(sample => Number.isFinite(sample.timestamp) && sample.disk > 0 && sample.diskTotal > 0)
    .sort((left, right) => left.timestamp - right.timestamp)

  if (samples.length < 2)
    return null

  const first = samples[0]
  const latest = samples.at(-1)
  if (!first || !latest)
    return null

  const sampleDays = (latest.timestamp - first.timestamp) / MS_PER_DAY
  if (sampleDays < MIN_DISK_PREDICTION_SAMPLE_DAYS)
    return null

  const xs = samples.map(sample => (sample.timestamp - first.timestamp) / MS_PER_DAY)
  const ys = samples.map(sample => sample.disk)
  const avgX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const avgY = ys.reduce((sum, value) => sum + value, 0) / ys.length

  let numerator = 0
  let denominator = 0
  let totalVariance = 0
  for (let index = 0; index < samples.length; index++) {
    const x = xs[index] ?? 0
    const y = ys[index] ?? 0
    numerator += (x - avgX) * (y - avgY)
    denominator += (x - avgX) ** 2
    totalVariance += (y - avgY) ** 2
  }

  if (denominator <= 0)
    return null

  const dailyGrowthBytes = numerator / denominator
  if (!Number.isFinite(dailyGrowthBytes) || dailyGrowthBytes <= 0)
    return null

  const diskTotalBytes = latest.diskTotal || fallbackDiskTotal
  const currentDiskBytes = latest.disk
  const remainingBytes = diskTotalBytes - currentDiskBytes
  if (remainingBytes <= 0) {
    return {
      daysUntilFull: 0,
      dailyGrowthBytes,
      currentDiskBytes,
      diskTotalBytes,
      sampleDays,
      confidence: 1,
    }
  }

  let residualVariance = 0
  for (let index = 0; index < samples.length; index++) {
    const x = xs[index] ?? 0
    const y = ys[index] ?? 0
    const predicted = avgY + dailyGrowthBytes * (x - avgX)
    residualVariance += (y - predicted) ** 2
  }

  const confidence = totalVariance <= 0
    ? 0
    : Math.min(Math.max(1 - residualVariance / totalVariance, 0), 1)

  return {
    daysUntilFull: remainingBytes / dailyGrowthBytes,
    dailyGrowthBytes,
    currentDiskBytes,
    diskTotalBytes,
    sampleDays,
    confidence,
  }
}

export function useNodeLoadStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    diskTotal?: MaybeRefOrGetter<number>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolved = computed(() => ({
    uuid: toValue(uuid),
    hours: Math.max(1, Math.floor(toValue(options?.hours) ?? 24)),
    enabled: toValue(options?.enabled) ?? true,
    diskTotal: Math.max(0, toValue(options?.diskTotal) ?? 0),
  }))

  let activeHours: number | null = null
  let releaseSharedRecords: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null): void {
    if (activeHours === hours)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeHours = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedLoadRecordsEntry(hours)
    activeHours = hours
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  const records = computed<StatusRecord[]>(() => {
    const { uuid: nodeUuid, hours, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return []

    const entry = getSharedLoadRecordsEntry(hours)
    return entry.data.value?.recordsByClient.get(nodeUuid) ?? []
  })

  const diskPrediction = computed(() => buildDiskPrediction(records.value, resolved.value.diskTotal))

  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, enabled } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      syncSharedRecordsSubscription(hours)
      const entry = getSharedLoadRecordsEntry(hours)
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
        await loadSharedLoadRecords(entry, hours)
        if (!cancelled && entry.fullLoadUnavailable) {
          const nodeFetchedAt = entry.nodeFetchedAt.get(nodeUuid) ?? 0
          const shouldLoadNodeRecords = !entry.data.value?.recordsByClient.has(nodeUuid)
            || Date.now() - nodeFetchedAt >= LOAD_RECORD_REFRESH_INTERVAL_MS
          if (shouldLoadNodeRecords)
            await loadNodeRecordsIntoEntry(entry, nodeUuid, hours)
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
    hasData: computed(() => records.value.length > 0),
  }
}
