import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver') as { ZipArchive: new (options: object) => {
  file: (path: string, options: { name: string }) => void
  finalize: () => Promise<void>
  once: (event: string, listener: (error: Error) => void) => void
  pipe: (output: NodeJS.WritableStream) => void
} }

const root = resolve(import.meta.dir, '..')
const source = resolve(root, 'companion/transit-route-probe')
const outputPath = resolve(root, 'transit-route-probe-plugin.zip')

await rm(outputPath, { force: true })

await new Promise<void>((resolveArchive, reject) => {
  const output = createWriteStream(outputPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  output.once('close', resolveArchive)
  output.once('error', reject)
  archive.once('error', reject)
  archive.pipe(output)
  archive.file(resolve(source, 'komari-plugin.json'), { name: 'komari-plugin.json' })
  archive.file(resolve(source, 'script.js'), { name: 'script.js' })
  archive.file(resolve(source, 'protocol.cjs'), { name: 'protocol.cjs' })
  void archive.finalize()
})

console.log(`Created ${outputPath}`)
