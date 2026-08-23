import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Z.-]+)?$/i
const VERSION_FIELD_RE = /^(\s*"version"\s*:\s*")([^"]*)(")/m
const HELPER_VERSION_RE = /^(VERSION=")([^"]*)(")/m
const SCRIPT_VERSION_RE = /^(const PLUGIN_VERSION = ')([^']*)(')/m
const PATCH_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
const VERSION_SOURCE_FILE = 'komari-theme.json'
const COMPANION_MANIFEST_FILE = 'companion/transit-route-probe/komari-plugin.json'
const ROUTE_PROBE_HELPER_FILE = 'scripts/transit-route-probe-helper.sh'
const ROUTE_PROBE_SCRIPT_FILE = 'companion/transit-route-probe/script.js'

function readJsonVersion(relativePath: string): string {
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as { version?: unknown }

  if (typeof parsed.version !== 'string') {
    throw new TypeError(`${relativePath} does not contain a top-level string version field`)
  }

  return parsed.version
}

function readThemeVersion(): string {
  return readJsonVersion(VERSION_SOURCE_FILE)
}

function bumpPatchVersion(version: string): string {
  const match = PATCH_VERSION_RE.exec(version)

  if (!match) {
    throw new Error(`Cannot auto bump non-standard version: ${version}`)
  }

  const [, major, minor, patch] = match
  return `${major}.${minor}.${Number(patch) + 1}`
}

function readVersionArg(): string | undefined {
  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '-v' || arg === '--version') {
      const version = args[i + 1]
      if (!version) {
        throw new Error('Missing version after -v/--version')
      }
      return version
    }

    if (arg.startsWith('--version=')) {
      return arg.slice('--version='.length)
    }
  }

  return undefined
}

async function resolveVersion(): Promise<string> {
  const versionArg = readVersionArg()

  if (versionArg) {
    return versionArg
  }

  const currentVersion = readThemeVersion()
  const nextVersion = bumpPatchVersion(currentVersion)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = (await rl.question(
      `No version provided. Use ${nextVersion} (${currentVersion} -> ${nextVersion})? Enter y to confirm, or enter another version: `,
    )).trim()

    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      return nextVersion
    }

    if (answer) {
      return answer
    }

    throw new Error('No version provided')
  }
  finally {
    rl.close()
  }
}

function assertJsonHasVersionField(relativePath: string): void {
  readJsonVersion(relativePath)
  assertPatternMatches(relativePath, VERSION_FIELD_RE)
}

function assertPatternMatches(relativePath: string, pattern: RegExp): void {
  const content = readFileSync(resolve(process.cwd(), relativePath), 'utf8')

  if (!pattern.test(content)) {
    throw new Error(`${relativePath} does not contain the expected version field`)
  }
}

function updateJsonVersion(relativePath: string, version: string): void {
  const filePath = resolve(process.cwd(), relativePath)
  const content = readFileSync(filePath, 'utf8')
  const nextContent = content.replace(VERSION_FIELD_RE, `$1${version}$3`)

  JSON.parse(nextContent)
  writeFileSync(filePath, nextContent)
}

function updatePatternVersion(relativePath: string, pattern: RegExp, version: string): void {
  const filePath = resolve(process.cwd(), relativePath)
  const content = readFileSync(filePath, 'utf8')

  writeFileSync(filePath, content.replace(pattern, `$1${version}$3`))
}

function updateAllVersions(version: string): void {
  // Validate every file up front so a bad pattern in a later file can't leave
  // earlier files already bumped while the run aborts partway through.
  assertJsonHasVersionField(VERSION_SOURCE_FILE)
  assertJsonHasVersionField(COMPANION_MANIFEST_FILE)
  assertPatternMatches(ROUTE_PROBE_HELPER_FILE, HELPER_VERSION_RE)
  assertPatternMatches(ROUTE_PROBE_SCRIPT_FILE, SCRIPT_VERSION_RE)

  updateJsonVersion(VERSION_SOURCE_FILE, version)
  updateJsonVersion(COMPANION_MANIFEST_FILE, version)
  updatePatternVersion(ROUTE_PROBE_HELPER_FILE, HELPER_VERSION_RE, version)
  updatePatternVersion(ROUTE_PROBE_SCRIPT_FILE, SCRIPT_VERSION_RE, version)
}

function gitAdd(files: string[]): void {
  const result = spawnSync('git', ['add', ...files], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    throw new Error('git add failed')
  }
}

async function main(): Promise<void> {
  const version = await resolveVersion()

  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version: ${version}`)
  }

  updateAllVersions(version)
  gitAdd([VERSION_SOURCE_FILE, COMPANION_MANIFEST_FILE, ROUTE_PROBE_HELPER_FILE, ROUTE_PROBE_SCRIPT_FILE])
  console.log(`Prepared release version ${version}`)
  console.log(`Version source: ${VERSION_SOURCE_FILE}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
