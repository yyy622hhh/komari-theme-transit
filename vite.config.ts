import type { Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import vueDevTools from 'vite-plugin-vue-devtools'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
// archiver@8 dropped the callable factory export in favor of format-specific
// classes; ZipArchive keeps the same stream/event API the code below relies on.
const { ZipArchive } = require('archiver')

interface ThemeManifest {
  preview?: unknown
  version?: unknown
}

interface ArchiveFile {
  absolutePath: string
  archivePath: string
}

/**
 * 按 chunk 打印模块级构成，只在 `TRANSIT_ANALYZE=1` 时启用。
 *
 * 存在的理由：初始包有硬预算，但一旦顶红，没有工具就只能靠猜是谁把它撑大的。
 * 这里用 rollup 自带的 `chunk.modules` 元数据，不引第三方分析插件——分析工具
 * 本身不应该出现在依赖树和体积审计里。
 */
function bundleComposition(): Plugin {
  const TOP_MODULES_PER_CHUNK = 20
  return {
    name: 'transit-bundle-composition',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter(asset => asset.type === 'chunk')
        .map((chunk) => {
          const modules = Object.entries(chunk.modules)
            .map(([id, info]) => ({
              id: relative(__dirname, id.replace(/^\0/, '')),
              bytes: info.renderedLength,
            }))
            .filter(module => module.bytes > 0)
            .sort((left, right) => right.bytes - left.bytes)
          return {
            file: chunk.fileName,
            isEntry: chunk.isEntry,
            bytes: chunk.code.length,
            moduleCount: modules.length,
            modules: modules.slice(0, TOP_MODULES_PER_CHUNK),
          }
        })
        .sort((left, right) => right.bytes - left.bytes)

      for (const chunk of chunks.filter(chunk => chunk.isEntry)) {
        console.warn(`\n[composition] ${chunk.file} — ${(chunk.bytes / 1024).toFixed(1)} KiB raw, ${chunk.moduleCount} modules`)
        for (const module of chunk.modules)
          console.warn(`  ${(module.bytes / 1024).toFixed(1).padStart(7)} KiB  ${module.id}`)
      }

      this.emitFile({
        type: 'asset',
        fileName: 'bundle-composition.json',
        source: `${JSON.stringify(chunks, null, 2)}\n`,
      })
    },
  }
}

const themeJsonPath = resolve(__dirname, 'komari-theme.json')
const devApiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:25774'
const isFunctionalTestBuild = process.env.VITE_COMPONENT_BOUNDARY_TEST === 'true'

function readThemeManifest(): ThemeManifest {
  if (!existsSync(themeJsonPath))
    throw new Error('komari-theme.json not found')

  return JSON.parse(readFileSync(themeJsonPath, 'utf-8')) as ThemeManifest
}

function getThemeVersion(): string {
  const version = readThemeManifest().version

  if (typeof version !== 'string' || !version.trim())
    throw new TypeError('komari-theme.json does not contain a top-level string version field')

  return version.trim()
}

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  }
  catch {
    return 'unknown'
  }
}

function getArchiveDate(): Date {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH
  if (sourceDateEpoch) {
    const epochSeconds = Number(sourceDateEpoch)
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0)
      throw new TypeError('SOURCE_DATE_EPOCH must be a non-negative integer')
    return new Date(epochSeconds * 1000)
  }

  try {
    const epochSeconds = Number(execSync('git log -1 --format=%ct', { encoding: 'utf-8' }).trim())
    if (Number.isSafeInteger(epochSeconds) && epochSeconds >= 0)
      return new Date(epochSeconds * 1000)
  }
  catch {
    // Fall through to the ZIP epoch when building outside a Git checkout.
  }

  return new Date('1980-01-01T00:00:00.000Z')
}

function collectSortedArchiveFiles(root: string, archiveRoot: string): ArchiveFile[] {
  const files: ArchiveFile[] = []

  function visit(directory: string, archiveDirectory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name)
      const archivePath = `${archiveDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        visit(absolutePath, archivePath)
        continue
      }
      if (!entry.isFile())
        throw new Error(`Release blocked: unsupported dist entry ${archivePath}`)
      files.push({ absolutePath, archivePath })
    }
  }

  visit(root, archiveRoot)
  return files.sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0)
}

/**
 * Vite 插件：构建后打包 Komari 主题 Zip
 * theme.zip
 * ├── komari-theme.json
 * ├── preview.png
 * └── dist/
 */
function komariThemeZip(): Plugin {
  return {
    name: 'komari-theme-zip',
    apply: 'build',
    closeBundle: async () => {
      const commitHash = getCommitHash()
      const zipFileName = `komari-theme-Transit-build-${commitHash}.zip`
      const distDir = resolve(__dirname, 'dist')
      const embeddedAdminDir = resolve(distDir, 'admin-app')
      const previewPath = resolve(__dirname, 'docs/preview.png')
      const outputPath = resolve(__dirname, zipFileName)
      const themeManifest = readThemeManifest()
      const archiveDate = getArchiveDate()
      const manifestPreviewName = typeof themeManifest.preview === 'string' && themeManifest.preview.trim()
        ? themeManifest.preview.trim()
        : 'preview.png'

      if (!existsSync(distDir)) {
        console.log('[komari-theme-zip] dist directory not found, skipping zip creation')
        return
      }

      if (existsSync(embeddedAdminDir)) {
        throw new Error('Release blocked: dist/admin-app must not be redistributed without an explicit komari-web license')
      }

      const output = fs.createWriteStream(outputPath)
      const archive = new ZipArchive({ zlib: { level: 9 } })

      return new Promise((resolve, reject) => {
        output.on('close', () => {
          const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2)
          console.log(`[komari-theme-zip] Created ${zipFileName} (${sizeMB} MB)`)
          resolve(undefined)
        })

        archive.on('error', (err: Error) => {
          console.error('[komari-theme-zip] Error:', err)
          reject(err)
        })

        archive.pipe(output)

        archive.append(readFileSync(themeJsonPath), { name: 'komari-theme.json', date: archiveDate, mode: 0o644 })

        if (existsSync(previewPath)) {
          const preview = readFileSync(previewPath)
          archive.append(preview, { name: 'preview.png', date: archiveDate, mode: 0o644 })
          if (manifestPreviewName !== 'preview.png') {
            archive.append(preview, { name: manifestPreviewName, date: archiveDate, mode: 0o644 })
          }
        }

        archive.append('', { name: 'dist/', date: archiveDate, mode: 0o755 })
        for (const file of collectSortedArchiveFiles(distDir, 'dist'))
          archive.append(readFileSync(file.absolutePath), { name: file.archivePath, date: archiveDate, mode: 0o644 })

        archive.finalize()
      })
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(getThemeVersion()),
    __BUILD_GIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
    ...(process.env.TRANSIT_ANALYZE === '1' ? [bundleComposition()] : []),
    ...(!isFunctionalTestBuild ? [komariThemeZip()] : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    dedupe: ['three'],
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
        headers: { Origin: devApiTarget },
        rewriteWsOrigin: true,
        ws: true,
      },
      '/themes': {
        target: devApiTarget,
        changeOrigin: true,
        headers: { Origin: devApiTarget },
      },
    },
  },
  build: {
    outDir: isFunctionalTestBuild ? 'dist-functional' : 'dist',
    target: ['es2018', 'safari15.4'],
    cssTarget: 'safari15.4',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'echarts': ['echarts', 'vue-echarts'],
        },
      },
    },
  },
})
