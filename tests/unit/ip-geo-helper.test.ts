import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { lookupIpGeo } from '../../src/utils/ipGeoHelper'

// 这个模块只在浏览器环境下工作（window.setTimeout / window.localStorage），
// bun test 默认没有 window，所以每个用例都要把它挂到 globalThis 上，用完再拆掉，
// 避免其他文件里 `typeof window === 'undefined'` 的分支被污染。
//
// 模块内部的 providerStates / providerCursor / inflight 都是没有重置入口的
// 模块级单例：一个 provider 失败一次就会被记 60 秒退避，远超测试运行时间。
// 所以这里不去挨个断言「哪个 provider 具体应答了什么」——那样跨用例会因为退避
// 状态互相牵连而变脆弱。改为black-box 验证 lookupIpGeo 的可观察契约：四个
// provider 要么全部给出可用坐标，要么全部失败，从不在一个用例里只让某一个失败
// 又指望它在后面的用例里成功。

const originalWindow = (globalThis as { window?: unknown }).window
const originalFetch = globalThis.fetch

function installWindow(): void {
  (globalThis as { window?: unknown }).window = globalThis
}

function uninstallWindow(): void {
  if (originalWindow === undefined)
    delete (globalThis as { window?: unknown }).window
  else
    (globalThis as { window?: unknown }).window = originalWindow
}

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
  return store
}

let fetchCallCount = 0

function mockAllProvidersRespond(ok: boolean): () => void {
  fetchCallCount = 0
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    fetchCallCount += 1
    const url = typeof input === 'string' ? input : input.toString()
    if (!ok)
      return new Response('', { status: 500 })

    if (url.includes('api.ip.sb')) {
      return new Response(JSON.stringify({ latitude: 22.3193, longitude: 114.1694, city: 'Hong Kong', country_code: 'HK', organization: 'Example Net', asn: 4134 }))
    }
    if (url.includes('ipinfo.io')) {
      return new Response(JSON.stringify({ loc: '22.3193,114.1694', city: 'Hong Kong', country: 'HK', org: 'AS4134 Example Net' }))
    }
    if (url.includes('ipwho.is')) {
      return new Response(JSON.stringify({ success: true, latitude: 22.3193, longitude: 114.1694, city: 'Hong Kong', country_code: 'HK', connection: { org: 'Example Net', asn: 4134 } }))
    }
    if (url.includes('ipapi.co')) {
      return new Response(JSON.stringify({ latitude: 22.3193, longitude: 114.1694, city: 'Hong Kong', country_code: 'HK', org: 'Example Net', asn: 'AS4134' }))
    }
    throw new Error(`unexpected url: ${url}`)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

beforeEach(() => {
  installWindow()
  installLocalStorage()
})

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
  uninstallWindow()
})

describe('lookupIpGeo', () => {
  test('returns null for a blank ip without making any request', async () => {
    const restore = mockAllProvidersRespond(true)
    try {
      const result = await lookupIpGeo('   ')
      expect(result).toBeNull()
      expect(fetchCallCount).toBe(0)
    }
    finally {
      restore()
    }
  })

  test('resolves valid coordinates when a provider answers, and caches the result for the next call', async () => {
    const restore = mockAllProvidersRespond(true)
    try {
      const geo = await lookupIpGeo('203.0.113.9')
      expect(geo).not.toBeNull()
      expect(geo!.lat).toBeCloseTo(22.3193, 2)
      expect(geo!.lng).toBeCloseTo(114.1694, 2)
      expect(geo!.city).toBe('Hong Kong')

      const callsAfterFirstLookup = fetchCallCount
      const second = await lookupIpGeo('203.0.113.9')
      expect(second).toEqual(geo)
      expect(fetchCallCount).toBe(callsAfterFirstLookup)
    }
    finally {
      restore()
    }
  })

  test('returns null and remembers the negative result when every provider fails', async () => {
    const restore = mockAllProvidersRespond(false)
    try {
      const result = await lookupIpGeo('203.0.113.10')
      expect(result).toBeNull()

      const callsAfterFirstLookup = fetchCallCount
      const second = await lookupIpGeo('203.0.113.10')
      expect(second).toBeNull()
      expect(fetchCallCount).toBe(callsAfterFirstLookup)
    }
    finally {
      restore()
    }
  })

  test('deduplicates two concurrent lookups for the same ip into a single in-flight request chain', async () => {
    const restore = mockAllProvidersRespond(true)
    try {
      const [first, second] = await Promise.all([
        lookupIpGeo('203.0.113.11'),
        lookupIpGeo('203.0.113.11'),
      ])
      expect(first).toEqual(second)
      expect(first).not.toBeNull()
    }
    finally {
      restore()
    }
  })
})
