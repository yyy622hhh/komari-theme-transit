import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

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

if (unexpectedTopLevel.length || missingTopLevel.length || forbidden.length) {
  throw new Error([
    `Release audit failed for ${zipName}`,
    unexpectedTopLevel.length ? `Unexpected top-level entries: ${unexpectedTopLevel.join(', ')}` : '',
    missingTopLevel.length ? `Missing top-level entries: ${missingTopLevel.join(', ')}` : '',
    forbidden.length ? 'Forbidden embedded admin bundle detected' : '',
  ].filter(Boolean).join('\n'))
}

console.log(`Release audit passed: ${zipName} (${entries.length} entries, no embedded admin bundle)`)
