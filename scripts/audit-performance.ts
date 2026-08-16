import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

interface AssetBudget {
  gzipBytes: number
  label: string
  pattern: RegExp
  required: boolean
  rawBytes?: number
}

interface AssetMeasurement {
  file: string
  gzipBytes: number
  label: string
  rawBytes: number
}

const DIST_DIR = resolve(process.cwd(), 'dist')
const REPORT_DIR = resolve(process.cwd(), process.env.TRANSIT_PERF_REPORT_DIR ?? 'test-results/performance')
const INITIAL_GZIP_BUDGET = 145 * 1024
const ASSET_TAG_PATTERN = /<(?:script|link)\s[^>]*>/gi
const ASSET_URL_PATTERN = /(?:src|href)=["']([^"']+)["']/i
const LEADING_SLASH_PATTERN = /^\//
const budgets: AssetBudget[] = [
  { label: 'home-view', pattern: /^HomeView-[\w-]+\.js$/, gzipBytes: 30 * 1024, required: true },
  { label: 'init-runtime', pattern: /^init-[\w-]+\.js$/, gzipBytes: 6 * 1024, required: true },
  { label: 'globe.gl', pattern: /^globe\.gl-[\w-]+\.js$/, gzipBytes: 400 * 1024, rawBytes: 1_300 * 1024, required: true },
  { label: 'three', pattern: /^three\.module-[\w-]+\.js$/, gzipBytes: 205 * 1024, rawBytes: 780 * 1024, required: true },
]

function initialAssetUrls(html: string): string[] {
  const tags = html.match(ASSET_TAG_PATTERN) ?? []
  return [...new Set(tags.flatMap((tag) => {
    const url = tag.match(ASSET_URL_PATTERN)?.[1]
    return url?.startsWith('/assets/') ? [url] : []
  }))]
}

function measureAsset(label: string, file: string): AssetMeasurement {
  const content = readFileSync(resolve(DIST_DIR, 'assets', file))
  return {
    file,
    gzipBytes: gzipSync(content).byteLength,
    label,
    rawBytes: content.byteLength,
  }
}

const assetNames = readdirSync(resolve(DIST_DIR, 'assets'))
const measured = budgets.flatMap((budget) => {
  const candidates = assetNames
    .filter(file => budget.pattern.test(file))
    .sort((left, right) => statSync(resolve(DIST_DIR, 'assets', right)).size - statSync(resolve(DIST_DIR, 'assets', left)).size)
  if (!candidates.length && budget.required)
    throw new Error(`Performance audit failed: required ${budget.label} asset was not emitted`)
  return candidates.slice(0, 1).map(file => ({ budget, measurement: measureAsset(budget.label, file) }))
})

const html = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf8')
const initialAssets = initialAssetUrls(html).map(url => resolve(DIST_DIR, url.replace(LEADING_SLASH_PATTERN, '')))
const initialEntryPath = initialAssets.find(path => path.endsWith('.js'))
if (!initialEntryPath)
  throw new Error('Performance audit failed: index.html has no initial JavaScript entry')
const initialEntryContent = readFileSync(initialEntryPath)
const initialEntry: AssetMeasurement = {
  file: basename(initialEntryPath),
  gzipBytes: gzipSync(initialEntryContent).byteLength,
  label: 'initial-entry',
  rawBytes: initialEntryContent.byteLength,
}
const initialEntryBudget = 86 * 1024
const initialGzipBytes = initialAssets.reduce((total, path) => total + gzipSync(readFileSync(path)).byteLength, 0)
const failures: string[] = []
if (initialGzipBytes > INITIAL_GZIP_BUDGET)
  failures.push(`initial assets ${(initialGzipBytes / 1024).toFixed(1)} KiB > ${(INITIAL_GZIP_BUDGET / 1024).toFixed(0)} KiB`)
if (initialEntry.gzipBytes > initialEntryBudget)
  failures.push(`initial-entry gzip ${(initialEntry.gzipBytes / 1024).toFixed(1)} KiB > ${(initialEntryBudget / 1024).toFixed(0)} KiB`)

for (const { budget, measurement } of measured) {
  if (measurement.gzipBytes > budget.gzipBytes)
    failures.push(`${budget.label} gzip ${(measurement.gzipBytes / 1024).toFixed(1)} KiB > ${(budget.gzipBytes / 1024).toFixed(0)} KiB`)
  if (budget.rawBytes && measurement.rawBytes > budget.rawBytes)
    failures.push(`${budget.label} raw ${(measurement.rawBytes / 1024).toFixed(1)} KiB > ${(budget.rawBytes / 1024).toFixed(0)} KiB`)
}

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  initial: {
    assetCount: initialAssets.length,
    gzipBytes: initialGzipBytes,
    gzipBudgetBytes: INITIAL_GZIP_BUDGET,
  },
  assets: [
    { ...initialEntry, gzipBudgetBytes: initialEntryBudget, rawBudgetBytes: null },
    ...measured.map(({ budget, measurement }) => ({
      ...measurement,
      gzipBudgetBytes: budget.gzipBytes,
      rawBudgetBytes: budget.rawBytes ?? null,
    })),
  ],
  passed: failures.length === 0,
  failures,
}

mkdirSync(REPORT_DIR, { recursive: true })
const reportPath = resolve(REPORT_DIR, 'bundle-performance.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(`Performance trend report: ${basename(reportPath)}`)
console.log(`Initial gzip: ${(initialGzipBytes / 1024).toFixed(1)} KiB / ${(INITIAL_GZIP_BUDGET / 1024).toFixed(0)} KiB`)
console.log(`initial-entry: ${(initialEntry.gzipBytes / 1024).toFixed(1)} KiB gzip (${initialEntry.file})`)
for (const { budget, measurement } of measured)
  console.log(`${budget.label}: ${(measurement.gzipBytes / 1024).toFixed(1)} KiB gzip (${measurement.file})`)

if (failures.length)
  throw new Error(`Performance audit failed:\n${failures.join('\n')}`)
