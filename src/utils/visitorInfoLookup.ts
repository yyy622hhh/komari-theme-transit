/**
 * 依次查询 ipwho.is → ipapi.co → api.ip.sb，返回第一个成功响应的访客公网信息。
 *
 * 与 `ipGeoHelper.ts` 同类：面向第三方的低层 HTTP 客户端，不含 Vue 依赖，供
 * `VisitorInfo.vue` 这类组件直接调用。仅在 `visitorInfoEnabled` 主题设置开启
 * 时才会被触发。
 */

export interface VisitorLookupResult {
  ip: string
  city: string
  region: string
  country: string
  org: string
}

interface VisitorLookupProvider {
  url: string
  normalize: (data: unknown) => VisitorLookupResult | null
}

type JsonRecord = Record<string, unknown>

const VISITOR_LOOKUP_TIMEOUT_MS = 8000

const VISITOR_LOOKUP_PROVIDERS: VisitorLookupProvider[] = [
  {
    url: 'https://ipwho.is/',
    normalize: normalizeIpwhoData,
  },
  {
    url: 'https://ipapi.co/json/',
    normalize: normalizeIpapiData,
  },
  {
    url: 'https://api.ip.sb/geoip',
    normalize: normalizeIpSbData,
  },
]

/** 依次尝试每个供应商；`signal` 中止时立即停止，不再发起下一个请求。 */
export async function lookupVisitorInfo(signal: AbortSignal): Promise<VisitorLookupResult | null> {
  for (const provider of VISITOR_LOOKUP_PROVIDERS) {
    if (signal.aborted)
      return null
    const data = await fetchProviderData(provider, signal)
    if (data)
      return data
  }

  return null
}

async function fetchProviderData(provider: VisitorLookupProvider, signal: AbortSignal): Promise<VisitorLookupResult | null> {
  try {
    const data = await fetchJsonWithTimeout(provider.url, signal)
    return provider.normalize(data)
  }
  catch {
    return null
  }
}

/** 单个请求的超时之外，还要跟随调用方传入的 `signal`（组件卸载等）一起中止。 */
async function fetchJsonWithTimeout(url: string, outerSignal: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const abortFromOuter = () => controller.abort()
  if (outerSignal.aborted)
    controller.abort()
  outerSignal.addEventListener('abort', abortFromOuter)
  const timeoutId = window.setTimeout(() => controller.abort(), VISITOR_LOOKUP_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok)
      throw new Error(`Visitor info request failed: ${response.status}`)

    return await response.json()
  }
  finally {
    window.clearTimeout(timeoutId)
    outerSignal.removeEventListener('abort', abortFromOuter)
  }
}

function normalizeIpwhoData(data: unknown): VisitorLookupResult | null {
  if (!isRecord(data) || data.success === false)
    return null

  const connection = isRecord(data.connection) ? data.connection : {}

  return createVisitorLookupResult({
    ip: data.ip,
    city: data.city,
    region: data.region,
    country: data.country,
    org: pickString(connection.org, connection.isp, connection.domain),
  })
}

function normalizeIpapiData(data: unknown): VisitorLookupResult | null {
  if (!isRecord(data) || data.error === true)
    return null

  return createVisitorLookupResult({
    ip: data.ip,
    city: data.city,
    region: data.region,
    country: data.country_name,
    org: data.org,
  })
}

function normalizeIpSbData(data: unknown): VisitorLookupResult | null {
  if (!isRecord(data))
    return null

  return createVisitorLookupResult({
    ip: data.ip,
    city: data.city,
    region: data.region,
    country: data.country,
    org: pickString(data.organization, data.isp, data.asn_organization),
  })
}

function createVisitorLookupResult(data: Record<keyof VisitorLookupResult, unknown>): VisitorLookupResult | null {
  const ip = readString(data.ip)
  if (!ip)
    return null

  return {
    ip,
    city: readString(data.city),
    region: readString(data.region),
    country: readString(data.country),
    org: readString(data.org),
  }
}

function isRecord(data: unknown): data is JsonRecord {
  return typeof data === 'object' && data !== null
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    const text = readString(value)
    if (text)
      return text
  }

  return ''
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
