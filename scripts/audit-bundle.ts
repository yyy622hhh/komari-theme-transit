import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { formatKiB, formatKiBRounded, INITIAL_GZIP_HARD_LIMIT, INITIAL_GZIP_TARGET, judgeInitialGzip } from './bundle-budget'

const DIST_DIR = resolve(process.cwd(), 'dist')
const FORBIDDEN_PRELOADS = ['v3-history', 'echarts', 'globe', 'sortable', 'VisitorInfo', 'visitorFingerprint']
const FORBIDDEN_INITIAL_SNIPPETS = [
  { label: 'visitor IP provider', value: 'https://ipwho.is/' },
  { label: 'visitor fingerprint collector', value: 'WEBGL_debug_renderer_info' },
]
const MODULE_PRELOAD_TAG_PATTERN = /<link\s[^>]*rel=["']modulepreload["'][^>]*>/gi
const INITIAL_TAG_PATTERN = /<(?:script|link)\s[^>]*>/gi
const HREF_ATTRIBUTE_PATTERN = /href=["']([^"']+)["']/i
const ASSET_URL_ATTRIBUTE_PATTERN = /(?:src|href)=["']([^"']+)["']/i
const URL_SUFFIX_PATTERN = /[?#]/
const LEADING_SLASH_PATTERN = /^\//

const html = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf8')
const preloadTags = html.match(MODULE_PRELOAD_TAG_PATTERN) ?? []
const preloadUrls = preloadTags.flatMap(tag => tag.match(HREF_ATTRIBUTE_PATTERN)?.[1] ?? [])
const forbiddenPreloads = preloadUrls.filter(url => FORBIDDEN_PRELOADS.some(name => url.includes(name)))

if (forbiddenPreloads.length) {
  throw new Error(`Bundle audit failed: heavy chunks are preloaded on first load: ${forbiddenPreloads.join(', ')}`)
}

const initialTags = html.match(INITIAL_TAG_PATTERN) ?? []
const initialUrls = [...new Set(initialTags.flatMap((tag) => {
  const url = tag.match(ASSET_URL_ATTRIBUTE_PATTERN)?.[1]
  return url?.startsWith('/assets/') ? [url] : []
}))]

const assets = initialUrls.map((url) => {
  const relativePath = url.split(URL_SUFFIX_PATTERN, 1)[0]!.replace(LEADING_SLASH_PATTERN, '')
  const content = readFileSync(resolve(DIST_DIR, relativePath))
  const gzipBytes = gzipSync(content).byteLength
  return { url, gzipBytes, content: content.toString('utf8') }
})
const totalGzipBytes = assets.reduce((total, asset) => total + asset.gzipBytes, 0)
const forbiddenInitialCode = FORBIDDEN_INITIAL_SNIPPETS.flatMap(snippet => assets
  .filter(asset => asset.content.includes(snippet.value))
  .map(asset => `${snippet.label} in ${asset.url}`))

if (forbiddenInitialCode.length) {
  throw new Error(`Bundle audit failed: optional visitor code is present in initial assets: ${forbiddenInitialCode.join(', ')}`)
}

// 两级语义的定义和阈值都在 ./bundle-budget，audit-performance.ts 用的是同一份。
const assetBreakdown = assets.map(asset => `${formatKiB(asset.gzipBytes)} ${asset.url}`)
const verdict = judgeInitialGzip(totalGzipBytes)

if (verdict === 'fail') {
  throw new Error([
    `Bundle audit failed: initial assets are ${formatKiB(totalGzipBytes)} gzip`,
    `Hard limit: ${formatKiBRounded(INITIAL_GZIP_HARD_LIMIT)} gzip`,
    ...assetBreakdown,
  ].join('\n'))
}

if (verdict === 'warn') {
  console.warn([
    `Bundle audit warning: initial assets are ${formatKiB(totalGzipBytes)} gzip`,
    `Optimization target: ${formatKiBRounded(INITIAL_GZIP_TARGET)} gzip; hard limit: ${formatKiBRounded(INITIAL_GZIP_HARD_LIMIT)} gzip`,
    ...assetBreakdown,
  ].join('\n'))
}

console.log([
  `Bundle audit passed: ${formatKiB(totalGzipBytes)} / ${formatKiBRounded(INITIAL_GZIP_TARGET)} target (${formatKiBRounded(INITIAL_GZIP_HARD_LIMIT)} hard limit)`,
  `Initial assets: ${assets.length}; module preloads: ${preloadUrls.length}`,
].join('\n'))
