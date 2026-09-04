import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { formatKiB, formatKiBRounded, INITIAL_ENTRY_GZIP_BUDGET, INITIAL_GZIP_HARD_LIMIT, INITIAL_GZIP_TARGET, judgeInitialGzip } from './bundle-budget'

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
const ASSET_TAG_PATTERN = /<(?:script|link)\s[^>]*>/gi
const ASSET_URL_PATTERN = /(?:src|href)=["']([^"']+)["']/i
const LEADING_SLASH_PATTERN = /^\//
const budgets: AssetBudget[] = [
  { label: 'home-view', pattern: /^HomeView-[\w-]+\.js$/, gzipBytes: 24 * 1024, required: true },
  { label: 'init-runtime', pattern: /^init-[\w-]+\.js$/, gzipBytes: 6 * 1024, required: true },
  { label: 'sortable', pattern: /^sortable(?:\.esm)?-[\w-]+\.js$/, gzipBytes: 16 * 1024, required: true },
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
const initialGzipBytes = initialAssets.reduce((total, path) => total + gzipSync(readFileSync(path)).byteLength, 0)
const failures: string[] = []
const warnings: string[] = []

// 聚合初始体积走和 audit:bundle 同一套两级判定：目标线只警告，硬限才失败。
// 单 chunk 预算保持一条硬线——它们各自有明确余量，越过就是真的回归。
const initialVerdict = judgeInitialGzip(initialGzipBytes)
if (initialVerdict === 'fail')
  failures.push(`initial assets ${formatKiB(initialGzipBytes)} > ${formatKiBRounded(INITIAL_GZIP_HARD_LIMIT)} hard limit`)
else if (initialVerdict === 'warn')
  warnings.push(`initial assets ${formatKiB(initialGzipBytes)} > ${formatKiBRounded(INITIAL_GZIP_TARGET)} target`)

if (initialEntry.gzipBytes > INITIAL_ENTRY_GZIP_BUDGET)
  failures.push(`initial-entry gzip ${formatKiB(initialEntry.gzipBytes)} > ${formatKiBRounded(INITIAL_ENTRY_GZIP_BUDGET)}`)

for (const { budget, measurement } of measured) {
  if (measurement.gzipBytes > budget.gzipBytes)
    failures.push(`${budget.label} gzip ${formatKiB(measurement.gzipBytes)} > ${formatKiBRounded(budget.gzipBytes)}`)
  if (budget.rawBytes && measurement.rawBytes > budget.rawBytes)
    failures.push(`${budget.label} raw ${formatKiB(measurement.rawBytes)} > ${formatKiBRounded(budget.rawBytes)}`)
}

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  initial: {
    assetCount: initialAssets.length,
    gzipBytes: initialGzipBytes,
    gzipTargetBytes: INITIAL_GZIP_TARGET,
    gzipBudgetBytes: INITIAL_GZIP_HARD_LIMIT,
  },
  assets: [
    { ...initialEntry, gzipBudgetBytes: INITIAL_ENTRY_GZIP_BUDGET, rawBudgetBytes: null },
    ...measured.map(({ budget, measurement }) => ({
      ...measurement,
      gzipBudgetBytes: budget.gzipBytes,
      rawBudgetBytes: budget.rawBytes ?? null,
    })),
  ],
  passed: failures.length === 0,
  failures,
  warnings,
}

mkdirSync(REPORT_DIR, { recursive: true })
const reportPath = resolve(REPORT_DIR, 'bundle-performance.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(`Performance trend report: ${basename(reportPath)}`)
console.log(`Initial gzip: ${formatKiB(initialGzipBytes)} / ${formatKiBRounded(INITIAL_GZIP_TARGET)} target (${formatKiBRounded(INITIAL_GZIP_HARD_LIMIT)} hard limit)`)
console.log(`initial-entry: ${formatKiB(initialEntry.gzipBytes)} gzip / ${formatKiBRounded(INITIAL_ENTRY_GZIP_BUDGET)} (${initialEntry.file})`)
for (const { budget, measurement } of measured)
  console.log(`${budget.label}: ${formatKiB(measurement.gzipBytes)} gzip (${measurement.file})`)

for (const warning of warnings)
  console.warn(`Performance audit warning: ${warning}`)

if (failures.length)
  throw new Error(`Performance audit failed:\n${failures.join('\n')}`)
