/**
 * 根据 IP 在线查询地理坐标与城市，用于地球的城市级定位。
 *
 * 多个免费 HTTPS 服务依次回退（ip.sb → ipinfo.io → ipapi.co），任一返回经纬度即采用；
 * 结果按 IP 缓存到 localStorage（带版本与过期时间），避免重复请求与频率限制。
 * 全部失败时返回 null，调用方应回落到国家级定位。
 */

export interface IpGeo {
  lat: number
  lng: number
  city?: string
  countryCode?: string
  /** ASN 组织 / ISP 名称（用于识别厂商） */
  org?: string
  /** AS 号，如 "AS401115" */
  asn?: string
}

const CACHE_PREFIX = 'komari-theme-emerald:ipgeo'
const CACHE_VERSION = 2
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

interface CacheEntry {
  version: number
  updatedAt: number
  geo: IpGeo
}

function cacheKey(ip: string): string {
  return `${CACHE_PREFIX}:${ip}`
}

function isValidGeo(geo: unknown): geo is IpGeo {
  if (!geo || typeof geo !== 'object')
    return false
  const g = geo as Record<string, unknown>
  return typeof g.lat === 'number' && Number.isFinite(g.lat)
    && typeof g.lng === 'number' && Number.isFinite(g.lng)
}

function readCache(ip: string): IpGeo | null {
  if (typeof window === 'undefined')
    return null
  try {
    const raw = window.localStorage.getItem(cacheKey(ip))
    if (!raw)
      return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (parsed.version !== CACHE_VERSION)
      return null
    if (Date.now() - parsed.updatedAt > CACHE_TTL_MS)
      return null
    if (!isValidGeo(parsed.geo))
      return null
    return parsed.geo
  }
  catch {
    return null
  }
}

function writeCache(ip: string, geo: IpGeo): void {
  if (typeof window === 'undefined')
    return
  try {
    const entry: CacheEntry = { version: CACHE_VERSION, updatedAt: Date.now(), geo }
    window.localStorage.setItem(cacheKey(ip), JSON.stringify(entry))
  }
  catch {
    // 忽略写盘失败（隐私模式 / 配额已满）
  }
}

function toFinite(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim())
      return v.trim()
  }
  return undefined
}

type Provider = (ip: string) => Promise<IpGeo | null>

/** ip.sb：返回 latitude / longitude / city / country_code */
const fromIpSb: Provider = async (ip) => {
  const res = await fetch(`https://api.ip.sb/geoip/${ip}`)
  if (!res.ok)
    return null
  const d = await res.json() as Record<string, unknown>
  const lat = toFinite(d.latitude)
  const lng = toFinite(d.longitude)
  if (lat === null || lng === null)
    return null
  return {
    lat,
    lng,
    city: typeof d.city === 'string' ? d.city : undefined,
    countryCode: typeof d.country_code === 'string' ? d.country_code : undefined,
    org: pickString(d.organization, d.asn_organization, d.isp),
    asn: typeof d.asn === 'number' ? `AS${d.asn}` : pickString(d.asn),
  }
}

/** ipinfo.io：loc = "lat,lng"，city，country，org = "AS#### 组织名" */
const fromIpinfo: Provider = async (ip) => {
  const res = await fetch(`https://ipinfo.io/${ip}/json`)
  if (!res.ok)
    return null
  const d = await res.json() as Record<string, unknown>
  if (typeof d.loc !== 'string')
    return null
  const [latStr, lngStr] = d.loc.split(',')
  const lat = toFinite(latStr)
  const lng = toFinite(lngStr)
  if (lat === null || lng === null)
    return null
  const org = pickString(d.org)
  return {
    lat,
    lng,
    city: typeof d.city === 'string' ? d.city : undefined,
    countryCode: typeof d.country === 'string' ? d.country : undefined,
    org,
    asn: org?.match(/^AS\d+/)?.[0],
  }
}

/** ipapi.co：latitude / longitude / city / country_code */
const fromIpapiCo: Provider = async (ip) => {
  const res = await fetch(`https://ipapi.co/${ip}/json/`)
  if (!res.ok)
    return null
  const d = await res.json() as Record<string, unknown>
  const lat = toFinite(d.latitude)
  const lng = toFinite(d.longitude)
  if (lat === null || lng === null)
    return null
  return {
    lat,
    lng,
    city: typeof d.city === 'string' ? d.city : undefined,
    countryCode: typeof d.country_code === 'string' ? d.country_code : undefined,
    org: pickString(d.org),
    asn: pickString(d.asn),
  }
}

/** ipwho.is：latitude/longitude/city/country_code，connection.{org,isp,asn} */
const fromIpwhois: Provider = async (ip) => {
  const res = await fetch(`https://ipwho.is/${ip}`)
  if (!res.ok)
    return null
  const d = await res.json() as Record<string, unknown>
  if (d.success === false)
    return null
  const lat = toFinite(d.latitude)
  const lng = toFinite(d.longitude)
  if (lat === null || lng === null)
    return null
  const conn = (d.connection ?? {}) as Record<string, unknown>
  return {
    lat,
    lng,
    city: typeof d.city === 'string' ? d.city : undefined,
    countryCode: typeof d.country_code === 'string' ? d.country_code : undefined,
    org: pickString(conn.org, conn.isp),
    asn: typeof conn.asn === 'number' ? `AS${conn.asn}` : pickString(conn.asn),
  }
}

const PROVIDERS: Provider[] = [fromIpSb, fromIpinfo, fromIpwhois, fromIpapiCo]

// 轮询起始服务：每次查询从不同站点开始，避免所有请求都打到同一站点导致频控后整体失败
let providerCursor = 0
function orderedProviders(): Provider[] {
  const n = PROVIDERS.length
  const start = providerCursor % n
  providerCursor = (providerCursor + 1) % n
  return Array.from({ length: n }, (_, i) => PROVIDERS[(start + i) % n]!)
}

// 同一 IP 的并发查询去重
const inflight = new Map<string, Promise<IpGeo | null>>()

/**
 * 查询某个 IP 的地理坐标（含缓存与多服务回退）。失败返回 null。
 */
export async function lookupIpGeo(ip: string): Promise<IpGeo | null> {
  if (!ip)
    return null

  const cached = readCache(ip)
  if (cached)
    return cached

  const existing = inflight.get(ip)
  if (existing)
    return existing

  const task = (async () => {
    // 从轮询选出的起始站点开始，依次回退，分摊请求压力
    for (const provider of orderedProviders()) {
      try {
        const geo = await provider(ip)
        if (geo) {
          writeCache(ip, geo)
          return geo
        }
      }
      catch {
        // 静默失败，尝试下一个服务
      }
    }
    return null
  })()

  inflight.set(ip, task)
  try {
    return await task
  }
  finally {
    inflight.delete(ip)
  }
}
