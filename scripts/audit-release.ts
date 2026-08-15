import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const WHITESPACE_PATTERN = /\s+/
const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const zipName = `komari-theme-Transit-build-${commitHash}.zip`
const zipPath = resolve(process.cwd(), zipName)

if (!existsSync(zipPath))
  throw new Error(`Release zip not found: ${zipName}; run bun run build first`)

const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .map(entry => entry.trim())
  .filter(Boolean)

const topLevel = new Set(entries.map(entry => entry.split('/')[0]))
const expectedTopLevel = ['dist', 'komari-theme.json', 'preview.png']
const unexpectedTopLevel = [...topLevel].filter(entry => !expectedTopLevel.includes(entry))
const missingTopLevel = expectedTopLevel.filter(entry => !topLevel.has(entry))
const forbidden = entries.filter(entry => entry === 'dist/admin-app' || entry.startsWith('dist/admin-app/'))
const archiveManifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'komari-theme.json'], { encoding: 'utf8' })) as { version?: unknown }
const sourceManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'komari-theme.json'), 'utf8')) as { version?: unknown }
const detailedEntries = execFileSync('unzip', ['-ZTs', zipPath], { encoding: 'utf8' })
  .split('\n')
  .flatMap((line) => {
    const fields = line.trim().split(WHITESPACE_PATTERN)
    const mode = fields[0]
    const timestamp = fields[6]
    const name = fields.slice(7).join(' ')
    return mode && timestamp && name && (mode.startsWith('-') || mode.startsWith('d'))
      ? [{ mode, timestamp, name }]
      : []
  })
const archiveTimestamps = new Set(detailedEntries.map(entry => entry.timestamp))
const invalidModes = detailedEntries.filter(entry => entry.mode !== (entry.name.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'))

if (
  unexpectedTopLevel.length
  || missingTopLevel.length
  || forbidden.length
  || archiveManifest.version !== sourceManifest.version
  || detailedEntries.length !== entries.length
  || archiveTimestamps.size !== 1
  || invalidModes.length
) {
  throw new Error([
    `Release audit failed for ${zipName}`,
    unexpectedTopLevel.length ? `Unexpected top-level entries: ${unexpectedTopLevel.join(', ')}` : '',
    missingTopLevel.length ? `Missing top-level entries: ${missingTopLevel.join(', ')}` : '',
    forbidden.length ? 'Forbidden embedded admin bundle detected' : '',
    archiveManifest.version !== sourceManifest.version ? 'Packaged manifest version does not match the source manifest' : '',
    detailedEntries.length !== entries.length ? 'Could not inspect every archive entry metadata record' : '',
    archiveTimestamps.size !== 1 ? 'Archive entry timestamps are not deterministic' : '',
    invalidModes.length ? `Unexpected archive modes: ${invalidModes.slice(0, 5).map(entry => `${entry.mode} ${entry.name}`).join(', ')}` : '',
  ].filter(Boolean).join('\n'))
}

console.log(`Release audit passed: ${zipName} (${entries.length} deterministic entries, no embedded admin bundle)`)
