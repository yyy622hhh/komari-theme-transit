import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const WHITESPACE_PATTERN = /\s+/
const TEST_ARTIFACT_PATTERN = /ComponentErrorBoundaryProbe|component-boundary-test/i
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
const forbiddenTestArtifacts = entries.filter(entry => TEST_ARTIFACT_PATTERN.test(entry))
const duplicateEntries = entries.filter((entry, index) => entries.indexOf(entry) !== index)
const distFiles = entries.filter(entry => entry.startsWith('dist/') && entry !== 'dist/')
const sortedDistFiles = [...distFiles].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
const archiveRoots = new Set(entries.slice(0, 3))
const deterministicOrder = archiveRoots.size === 3
  && archiveRoots.has('komari-theme.json')
  && archiveRoots.has('preview.png')
  && archiveRoots.has('dist/')
  && distFiles.every((entry, index) => entry === sortedDistFiles[index])
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
const entryMetadata = new Map(detailedEntries.map(entry => [entry.name, entry]))
const requiredFiles = ['komari-theme.json', 'preview.png', 'dist/index.html']
const invalidRequiredFiles = requiredFiles.filter(name => entryMetadata.get(name)?.mode !== '-rw-r--r--')
const packagedPreview = execFileSync('unzip', ['-p', zipPath, 'preview.png'])
const sourcePreview = readFileSync(resolve(process.cwd(), 'docs/preview.png'))
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex')
const previewMatches = digest(packagedPreview) === digest(sourcePreview)

if (
  unexpectedTopLevel.length
  || missingTopLevel.length
  || forbidden.length
  || forbiddenTestArtifacts.length
  || duplicateEntries.length
  || !deterministicOrder
  || archiveManifest.version !== sourceManifest.version
  || detailedEntries.length !== entries.length
  || archiveTimestamps.size !== 1
  || invalidModes.length
  || invalidRequiredFiles.length
  || !previewMatches
) {
  throw new Error([
    `Release audit failed for ${zipName}`,
    unexpectedTopLevel.length ? `Unexpected top-level entries: ${unexpectedTopLevel.join(', ')}` : '',
    missingTopLevel.length ? `Missing top-level entries: ${missingTopLevel.join(', ')}` : '',
    forbidden.length ? 'Forbidden embedded admin bundle detected' : '',
    forbiddenTestArtifacts.length ? `Forbidden functional-test artifacts: ${forbiddenTestArtifacts.join(', ')}` : '',
    duplicateEntries.length ? `Duplicate archive entries: ${[...new Set(duplicateEntries)].join(', ')}` : '',
    !deterministicOrder ? 'Archive entries are not in the deterministic manifest/preview/dist/sorted-files order' : '',
    archiveManifest.version !== sourceManifest.version ? 'Packaged manifest version does not match the source manifest' : '',
    detailedEntries.length !== entries.length ? 'Could not inspect every archive entry metadata record' : '',
    archiveTimestamps.size !== 1 ? 'Archive entry timestamps are not deterministic' : '',
    invalidModes.length ? `Unexpected archive modes: ${invalidModes.slice(0, 5).map(entry => `${entry.mode} ${entry.name}`).join(', ')}` : '',
    invalidRequiredFiles.length ? `Missing or invalid required files: ${invalidRequiredFiles.join(', ')}` : '',
    !previewMatches ? 'Packaged preview.png does not match docs/preview.png' : '',
  ].filter(Boolean).join('\n'))
}

console.log(`Release audit passed: ${zipName} (${entries.length} deterministic entries, no embedded admin bundle)`)
