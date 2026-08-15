import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

const DIST_DIR = resolve(process.cwd(), 'dist')
const INITIAL_GZIP_TARGET = 145 * 1024
const INITIAL_GZIP_HARD_LIMIT = 165 * 1024
const FORBIDDEN_PRELOADS = ['v3-history', 'echarts', 'globe']
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
  const gzipBytes = gzipSync(readFileSync(resolve(DIST_DIR, relativePath))).byteLength
  return { url, gzipBytes }
})
const totalGzipBytes = assets.reduce((total, asset) => total + asset.gzipBytes, 0)

if (totalGzipBytes > INITIAL_GZIP_HARD_LIMIT) {
  throw new Error([
    `Bundle audit failed: initial assets are ${(totalGzipBytes / 1024).toFixed(1)} KiB gzip`,
    `Hard limit: ${(INITIAL_GZIP_HARD_LIMIT / 1024).toFixed(0)} KiB gzip`,
    ...assets.map(asset => `${(asset.gzipBytes / 1024).toFixed(1)} KiB ${asset.url}`),
  ].join('\n'))
}

if (totalGzipBytes > INITIAL_GZIP_TARGET) {
  throw new Error([
    `Bundle audit failed: initial assets are ${(totalGzipBytes / 1024).toFixed(1)} KiB gzip`,
    `Optimization target: ${(INITIAL_GZIP_TARGET / 1024).toFixed(0)} KiB gzip; hard limit: ${(INITIAL_GZIP_HARD_LIMIT / 1024).toFixed(0)} KiB gzip`,
    ...assets.map(asset => `${(asset.gzipBytes / 1024).toFixed(1)} KiB ${asset.url}`),
  ].join('\n'))
}

console.log([
  `Bundle audit passed: ${(totalGzipBytes / 1024).toFixed(1)} KiB / ${(INITIAL_GZIP_TARGET / 1024).toFixed(0)} KiB target (${(INITIAL_GZIP_HARD_LIMIT / 1024).toFixed(0)} KiB hard limit)`,
  `Initial assets: ${assets.length}; module preloads: ${preloadUrls.length}`,
].join('\n'))
