import type { NodeData } from '@/stores/nodes'
import type { IpGeo } from '@/utils/ipGeoHelper'
import { computed, onMounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getCoordByCode, getCountryCodeFromRegion } from '@/utils/geoHelper'
import { formatBytesPerSecondSplit } from '@/utils/helper'
import { lookupIpGeo } from '@/utils/ipGeoHelper'

interface UseNodeGeoClustersOptions {
  nodes?: () => NodeData[] | undefined
}

export interface RegionCluster {
  id: string
  code: string
  coord: [number, number]
  label: string
  asn?: string
  org?: string
  servers: number
  onlineServers: number
}

export interface RegionRate {
  up: number
  down: number
}

export interface GeoRoute {
  id: string
  from: [number, number]
  to: [number, number]
  rate: number
  speedMs: number
}

interface ClusterSummary {
  clusters: RegionCluster[]
  rates: Map<string, RegionRate>
  totalServers: number
  onlineServers: number
}

const CITY_SLUG_INVALID_REGEX = /[^a-z0-9]+/g
const CITY_SLUG_EDGE_REGEX = /^-+|-+$/g
const VISITOR_COORD_KEY = 'visitor_coord'
const SAME_COORD_EPSILON = 0.01
const IP_GEO_LOOKUP_BATCH_SIZE = 8
const VISITOR_GEO_TIMEOUT_MS = 5000

function isFiniteCoord(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && typeof value[0] === 'number'
    && Number.isFinite(value[0])
    && typeof value[1] === 'number'
    && Number.isFinite(value[1])
}

function isSameCoord(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < SAME_COORD_EPSILON
    && Math.abs(a[1] - b[1]) < SAME_COORD_EPSILON
}

function readCachedVisitorCoord(): [number, number] | null {
  if (typeof window === 'undefined')
    return null

  try {
    const cached = window.localStorage.getItem(VISITOR_COORD_KEY)
    if (!cached)
      return null
    const parsed = JSON.parse(cached) as unknown
    return isFiniteCoord(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

function writeCachedVisitorCoord(coord: [number, number]) {
  if (typeof window === 'undefined')
    return

  try {
    window.localStorage.setItem(VISITOR_COORD_KEY, JSON.stringify(coord))
  }
  catch {
    // 忽略写盘失败（隐私模式 / 配额已满）
  }
}

export function useNodeGeoClusters(options: UseNodeGeoClustersOptions = {}) {
  const appStore = useAppStore()
  const nodesStore = useNodesStore()

  const displayNodes = computed(() => options.nodes?.() ?? nodesStore.nodes)
  const visitorCoord = ref<[number, number] | null>(null)
  const ipGeoMap = ref(new Map<string, IpGeo>())
  const attemptedIps = new Set<string>()

  async function resolveNodeCities(nodes: NodeData[]): Promise<void> {
    const ips: string[] = []
    const seenIps = new Set<string>()
    for (const node of nodes) {
      const ip = node.ipv4 || node.ipv6
      if (!ip || seenIps.has(ip) || attemptedIps.has(ip) || ipGeoMap.value.has(ip))
        continue

      seenIps.add(ip)
      attemptedIps.add(ip)
      ips.push(ip)
    }

    for (let i = 0; i < ips.length; i += IP_GEO_LOOKUP_BATCH_SIZE) {
      const batch = ips.slice(i, i + IP_GEO_LOOKUP_BATCH_SIZE)
      const results = await Promise.all(batch.map(async (ip) => {
        const geo = await lookupIpGeo(ip)
        return geo ? { ip, geo } : null
      }))
      const resolved = results.filter((result): result is { ip: string, geo: IpGeo } => result !== null)
      if (!resolved.length)
        continue

      const next = new Map(ipGeoMap.value)
      for (const { ip, geo } of resolved) {
        next.set(ip, geo)
      }
      ipGeoMap.value = next
    }
  }

  function nodeClusterInfo(node: NodeData): { id: string, code: string, coord: [number, number], label: string, asn?: string, org?: string } | null {
    const countryCode = getCountryCodeFromRegion(node.region)
    const ip = node.ipv4 || node.ipv6
    const geo = ip ? ipGeoMap.value.get(ip) : undefined

    if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
      const code = (geo.countryCode || countryCode || '').toUpperCase()
      const citySlug = (geo.city || `${geo.lat.toFixed(2)},${geo.lng.toFixed(2)}`)
        .toLowerCase()
        .replace(CITY_SLUG_INVALID_REGEX, '-')
        .replace(CITY_SLUG_EDGE_REGEX, '')
      return {
        id: `${(code || 'xx').toLowerCase()}-${citySlug || 'city'}`,
        code: code || (countryCode ?? ''),
        coord: [geo.lat, geo.lng],
        label: geo.city || node.region || code || 'Unknown',
        asn: geo.asn,
        org: geo.org,
      }
    }

    if (countryCode) {
      const coord = getCoordByCode(countryCode)
      if (coord)
        return { id: countryCode.toLowerCase(), code: countryCode, coord, label: node.region || countryCode }
    }

    return null
  }

  const clusterSummary = computed<ClusterSummary>(() => {
    const clustersById = new Map<string, RegionCluster>()
    const rates = new Map<string, RegionRate>()
    let onlineServers = 0

    for (const node of displayNodes.value) {
      if (node.online)
        onlineServers += 1

      const info = nodeClusterInfo(node)
      if (!info)
        continue

      let cluster = clustersById.get(info.id)
      if (!cluster) {
        cluster = { id: info.id, code: info.code, coord: info.coord, label: info.label, asn: info.asn, org: info.org, servers: 0, onlineServers: 0 }
        clustersById.set(info.id, cluster)
      }
      if (!cluster.asn && info.asn)
        cluster.asn = info.asn
      if (!cluster.org && info.org)
        cluster.org = info.org
      cluster.servers += 1

      if (!node.online)
        continue

      cluster.onlineServers += 1
      let rate = rates.get(info.id)
      if (!rate) {
        rate = { up: 0, down: 0 }
        rates.set(info.id, rate)
      }
      rate.up += node.net_out || 0
      rate.down += node.net_in || 0
    }

    return {
      clusters: Array.from(clustersById.values()).sort((a, b) => b.servers - a.servers),
      rates,
      totalServers: displayNodes.value.length,
      onlineServers,
    }
  })

  const regionClusters = computed<RegionCluster[]>(() => clusterSummary.value.clusters)
  const regionRates = computed<Map<string, RegionRate>>(() => clusterSummary.value.rates)

  const routes = computed<GeoRoute[]>(() => {
    const clusters = regionClusters.value
    if (clusters.length === 0)
      return []

    const fromCoord = visitorCoord.value ?? clusters[0]?.coord
    if (!fromCoord)
      return []

    return clusters
      .filter(cluster => !isSameCoord(fromCoord, cluster.coord))
      .map((cluster) => {
        const rate = rateFor(cluster.id)
        const totalRate = rate.up + rate.down
        const speedMs = Math.round(Math.min(Math.max(3200 - Math.log10(totalRate + 1) * 420, 900), 3200))
        return {
          id: cluster.id,
          from: fromCoord,
          to: cluster.coord,
          rate: totalRate,
          speedMs,
        }
      })
  })

  const totalServers = computed(() => clusterSummary.value.totalServers)
  const onlineServers = computed(() => clusterSummary.value.onlineServers)
  const offlineServers = computed(() => totalServers.value - onlineServers.value)

  function clusterKey(cluster: RegionCluster) {
    return `${cluster.id}:${cluster.coord[0]},${cluster.coord[1]}:${cluster.label}:${cluster.asn ?? ''}:${cluster.org ?? ''}:${cluster.servers}:${cluster.onlineServers}`
  }

  function routeKey(route: GeoRoute) {
    return `${route.id}:${route.from[0]},${route.from[1]}:${route.to[0]},${route.to[1]}`
  }

  function rateFor(id: string): RegionRate {
    return regionRates.value.get(id) ?? { up: 0, down: 0 }
  }

  function formatRate(bytesPerSec: number): string {
    const { value, unit } = formatBytesPerSecondSplit(bytesPerSec, appStore.byteDecimals)
    return `${value} ${unit}`
  }

  async function loadVisitorCoord() {
    if (!appStore.visitorGeoArcEnabled)
      return

    const cached = readCachedVisitorCoord()
    if (cached) {
      visitorCoord.value = cached
      return
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), VISITOR_GEO_TIMEOUT_MS)
    try {
      const res = await fetch('https://ipapi.co/json/', { signal: controller.signal })
      if (!res.ok)
        return
      const data = await res.json() as { latitude?: unknown, longitude?: unknown }
      if (typeof data.latitude === 'number' && Number.isFinite(data.latitude)
        && typeof data.longitude === 'number' && Number.isFinite(data.longitude)) {
        const coord: [number, number] = [data.latitude, data.longitude]
        visitorCoord.value = coord
        writeCachedVisitorCoord(coord)
      }
    }
    catch {
      // 静默失败，降级到 hub 连线
    }
    finally {
      window.clearTimeout(timeoutId)
    }
  }

  watch(displayNodes, (nodes) => {
    void resolveNodeCities(nodes)
  }, { immediate: true })

  watch(() => appStore.visitorGeoArcEnabled, (enabled) => {
    if (!enabled) {
      visitorCoord.value = null
      return
    }
    void loadVisitorCoord()
  })

  onMounted(() => {
    void loadVisitorCoord()
  })

  return {
    displayNodes,
    visitorCoord,
    regionClusters,
    regionRates,
    routes,
    totalServers,
    onlineServers,
    offlineServers,
    clusterKey,
    routeKey,
    rateFor,
    formatRate,
  }
}
