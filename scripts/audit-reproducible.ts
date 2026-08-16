import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

function releaseZipPath(): string {
  const revision = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (revision.status !== 0)
    throw new Error('Could not resolve the current Git revision')
  return resolve(process.cwd(), `komari-theme-Transit-build-${revision.stdout.trim()}.zip`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function buildRelease(): void {
  const rebuild = spawnSync(process.execPath, ['run', 'build-only'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (rebuild.status !== 0)
    throw new Error('Reproducibility audit rebuild failed')
}

const zipPath = releaseZipPath()
buildRelease()
const firstHash = sha256(zipPath)
buildRelease()
const secondHash = sha256(zipPath)
if (firstHash !== secondHash)
  throw new Error(`Release zip is not reproducible: ${firstHash} != ${secondHash}`)

console.log(`Same-environment reproducibility audit passed: ${firstHash}`)
