import { readFile } from 'node:fs/promises'

interface BunLockPackage {
  name: string
  version: string
}

interface OsvVulnerability {
  id?: string
  summary?: string
  database_specific?: { severity?: string }
}

interface OsvResult {
  vulns?: OsvVulnerability[]
}

const PACKAGE_RESOLUTION_PATTERN = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/
const PACKAGE_ENTRY_PATTERN = /^\u0020{4}"(?:[^"\\]|\\.)*":\s*\[("(?:[^"\\]|\\.)*")/
const LINE_BREAK_PATTERN = /\r?\n/

function parsePackageResolution(resolution: string): BunLockPackage | null {
  const match = resolution.match(PACKAGE_RESOLUTION_PATTERN)
  if (!match?.[1] || !match[2])
    return null
  return { name: match[1], version: match[2] }
}

function getLockedPackages(lockText: string): BunLockPackage[] {
  // bun.lock is JSONC: trailing commas make JSON.parse unsuitable. Package
  // entries are deliberately parsed from the top-level packages block only.
  const packages = new Map<string, BunLockPackage>()
  let insidePackages = false

  for (const line of lockText.split(LINE_BREAK_PATTERN)) {
    if (line === '  "packages": {') {
      insidePackages = true
      continue
    }
    if (insidePackages && line === '  },')
      break
    if (!insidePackages)
      continue

    const entry = line.match(PACKAGE_ENTRY_PATTERN)
    if (!entry?.[1])
      continue
    const parsed = parsePackageResolution(JSON.parse(entry[1]) as string)
    if (parsed)
      packages.set(`${parsed.name}@${parsed.version}`, parsed)
  }

  if (!insidePackages || packages.size === 0)
    throw new TypeError('bun.lock does not contain parseable npm packages')
  return [...packages.values()]
}

async function queryOsv(packages: BunLockPackage[]): Promise<OsvResult[]> {
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      queries: packages.map(({ name, version }) => ({
        package: { name, ecosystem: 'npm' },
        version,
      })),
    }),
  })
  if (!response.ok)
    throw new Error(`OSV API returned HTTP ${response.status}`)
  const body = await response.json() as { results?: unknown }
  if (!Array.isArray(body.results))
    throw new TypeError('OSV API returned an invalid result')
  return body.results as OsvResult[]
}

const packages = getLockedPackages(await readFile('bun.lock', 'utf8'))
const results = await queryOsv(packages)
const findings = results.flatMap((result, index) => (result.vulns ?? []).map(vulnerability => ({
  package: packages[index],
  vulnerability,
})))

for (const finding of findings) {
  const severity = finding.vulnerability.database_specific?.severity ?? 'UNKNOWN'
  console.log(`${severity}\t${finding.package.name}@${finding.package.version}\t${finding.vulnerability.id ?? 'unknown'}\t${finding.vulnerability.summary ?? ''}`)
}

const blockingFindings = findings.filter(({ vulnerability }) => {
  const severity = vulnerability.database_specific?.severity?.toUpperCase()
  return severity === 'HIGH' || severity === 'CRITICAL'
})

if (blockingFindings.length > 0)
  throw new Error(`OSV dependency audit found ${blockingFindings.length} high/critical vulnerabilities`)

console.log(`OSV dependency audit passed: ${packages.length} locked npm packages checked; ${findings.length} findings, none high/critical`)
