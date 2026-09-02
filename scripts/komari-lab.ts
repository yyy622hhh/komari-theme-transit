import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { verifyRouteProbeLab } from './komari-plugin-lab'

interface ReleaseSpec {
  sha256: string
  themeUpload: 'chunked' | 'legacy'
  url: string
  usesInstallGuide: boolean
}

interface RpcResponse<T> {
  error?: { code?: number, message?: string }
  result?: T
}

interface ApiResponse<T> {
  data?: T
  message?: string
  status?: string
}

interface ThemeRecord {
  short?: string
  version?: string
}

interface ClientRecord {
  name?: string
  uuid: string
  weight?: number
}

const RELEASES: Record<string, ReleaseSpec> = {
  '1.2.5-fix2': {
    sha256: 'ead4866f4cb542024bbffece20dabd29cd544133f695b1aba2d582e7a6fe2f25',
    themeUpload: 'legacy',
    url: 'https://github.com/komari-monitor/komari/releases/download/1.2.5-fix2/komari-linux-amd64',
    usesInstallGuide: false,
  },
  '1.2.6': {
    sha256: '3e6283e2b84b0f084c8176591ecd03840e74fd63be78aae78b1cedd78567ca3c',
    themeUpload: 'legacy',
    url: 'https://github.com/komari-monitor/komari/releases/download/1.2.6/komari-linux-amd64',
    usesInstallGuide: false,
  },
  '1.4.2': {
    sha256: 'cb475f2fea441922416146d20897b11e214c8cdff9e370ee176a4dbcef727fb4',
    themeUpload: 'legacy',
    url: 'https://github.com/komari-monitor/komari/releases/download/1.4.2/komari-linux-amd64',
    usesInstallGuide: true,
  },
  '1.4.3': {
    sha256: '0ecded3f54270e98efd4d8853ed45f82239e2182d9f0f671c489bb4b4c3d14db',
    themeUpload: 'chunked',
    url: 'https://github.com/komari-monitor/komari/releases/download/1.4.3/komari-linux-amd64',
    usesInstallGuide: true,
  },
}

const version = process.env.KOMARI_VERSION ?? '1.4.3'
const spec = RELEASES[version]
if (!spec)
  throw new Error(`Unsupported KOMARI_VERSION ${version}; expected ${Object.keys(RELEASES).join(', ')}`)
if (process.platform !== 'linux' && !process.env.TRANSIT_KOMARI_BINARY)
  throw new Error('The real Komari lab requires Linux or TRANSIT_KOMARI_BINARY')

const workspace = process.cwd()
const labDir = mkdtempSync(join(tmpdir(), `transit-komari-${version}-`))
const dataDir = join(labDir, 'data')
const databasePath = join(dataDir, 'komari.db')
const metricsPath = join(dataDir, 'metrics.db')
const binaryPath = process.env.TRANSIT_KOMARI_BINARY
  ? resolve(process.env.TRANSIT_KOMARI_BINARY)
  : join(labDir, 'komari')
const username = `transit_${randomBytes(5).toString('hex')}`
const password = `Tt9${randomBytes(18).toString('base64url')}`
const RELEASE_ZIP_PATTERN = /^komari-theme-Transit-build-[\w-]+\.zip$/
const SESSION_COOKIE_PATTERN = /(?:^|,\s*)session_token=([^;]+)/
const ENTRY_ASSET_PATTERN = /(?:src|href)=["']([^"']+\.(?:js|css))["']/gi
const CHUNK_SIZE = 5 * 1024 * 1024
const themeDir = join(dataDir, 'theme', 'Transit')
const rollbackDir = join(labDir, 'rollback', 'Transit')
const displacedThemeDir = join(labDir, 'rollback', 'Transit.replaced')
const rollbackMarker = join(themeDir, '.transit-lab-rollback-canary')
const rollbackMarkerValue = `rollback-${randomBytes(12).toString('hex')}`
const themeCanaryValue = `komari-${version}-${randomBytes(8).toString('hex')}`
let serverProcess: ReturnType<typeof spawn> | null = null
let sessionCookie = ''
let rpcId = 0
const LAB_REQUEST_TIMEOUT_MS = 15_000

/** Keep a stalled disposable server or runner network from consuming the whole 60-minute job. */
async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return await globalThis.fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(LAB_REQUEST_TIMEOUT_MS),
  })
}

async function downloadBinary(): Promise<void> {
  if (process.env.TRANSIT_KOMARI_BINARY) {
    if (!existsSync(binaryPath))
      throw new Error('TRANSIT_KOMARI_BINARY does not exist')
    return
  }
  const response = await fetch(spec.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(`Komari download failed with HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== spec.sha256)
    throw new Error(`Komari ${version} checksum mismatch`)
  writeFileSync(binaryPath, bytes)
  chmodSync(binaryPath, 0o755)
}

function findReleaseZip(): string {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()
  const expected = join(workspace, `komari-theme-Transit-build-${commit}.zip`)
  if (!RELEASE_ZIP_PATTERN.test(basename(expected)) || !existsSync(expected))
    throw new Error(`Expected release zip for ${commit}; run bun run build first`)
  return expected
}

function validateInstalledTheme(): ThemeRecord {
  const manifest = JSON.parse(readFileSync(join(themeDir, 'komari-theme.json'), 'utf8')) as { version?: unknown }
  const sourceManifest = JSON.parse(readFileSync(join(workspace, 'komari-theme.json'), 'utf8')) as { version?: unknown }
  if (manifest.version !== sourceManifest.version)
    throw new Error('Installed theme manifest version does not match source')
  if (!existsSync(join(themeDir, 'dist', 'index.html')))
    throw new Error('Installed theme is missing dist/index.html')
  return { short: 'Transit', version: typeof manifest.version === 'string' ? manifest.version : undefined }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.unref()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (!address || typeof address === 'string') {
        socket.close()
        reject(new Error('Could not allocate a loopback port'))
        return
      }
      socket.close(() => resolvePort(address.port))
    })
  })
}

async function waitFor(url: string, expected: number[] = [200], timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode != null)
      throw new Error(`Komari ${version} exited before becoming ready`)
    try {
      const response = await fetch(url)
      lastStatus = response.status
      if (expected.includes(response.status))
        return response
    }
    catch {
      // The disposable server may not have bound the socket yet.
    }
    await delay(150)
  }
  throw new Error(`Timed out waiting for Komari ${version} (last HTTP ${lastStatus || 'unavailable'})`)
}

async function startServer(port: number): Promise<string> {
  const needsInstall = spec.usesInstallGuide && !existsSync(databasePath)
  serverProcess = spawn(
    binaryPath,
    [
      'server',
      '--listen',
      `127.0.0.1:${port}`,
      '--database',
      databasePath,
    ],
    { cwd: labDir, stdio: 'ignore' },
  )
  const baseUrl = `http://127.0.0.1:${port}`
  if (needsInstall) {
    await waitFor(`${baseUrl}/api/install/status`)
    const response = await fetch(`${baseUrl}/api/install/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        sitename: 'Transit Komari Lab',
        description: 'Disposable compatibility test',
        metric_dsn: metricsPath,
      }),
    })
    if (!response.ok)
      throw new Error(`Komari install guide failed with HTTP ${response.status}`)
  }
  await waitFor(`${baseUrl}/api/version`, [200], 45_000)
  return baseUrl
}

async function stopServer(): Promise<void> {
  if (!serverProcess || serverProcess.exitCode != null)
    return
  const processToStop = serverProcess
  processToStop.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => processToStop.once('exit', resolveExit)),
    delay(5_000),
  ])
  if (processToStop.exitCode == null) {
    processToStop.kill('SIGKILL')
    await Promise.race([
      new Promise(resolveExit => processToStop.once('exit', resolveExit)),
      delay(2_000),
    ])
  }
  serverProcess = null
}

function resetLegacyPassword(): void {
  const status = spawnSync(binaryPath, ['--database', databasePath, 'chpasswd', '--password', password], {
    cwd: labDir,
    stdio: 'ignore',
    timeout: 15_000,
  })
  if (status.status !== 0)
    throw new Error(`Could not initialize the Komari ${version} lab password`)
}

async function login(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: spec.usesInstallGuide ? username : 'admin', password }),
  })
  if (!response.ok)
    throw new Error(`Komari login failed with HTTP ${response.status}`)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const match = SESSION_COOKIE_PATTERN.exec(setCookie)
  if (!match)
    throw new Error('Komari login did not return a session cookie')
  sessionCookie = `session_token=${match[1]}`
}

async function readApiResponse<T>(response: Response, label: string): Promise<T | undefined> {
  let payload: ApiResponse<T>
  try {
    payload = await response.json() as ApiResponse<T>
  }
  catch {
    throw new Error(`${label} returned a non-JSON response with HTTP ${response.status}`)
  }
  if (!response.ok || payload.status !== 'success')
    throw new Error(`${label} failed with HTTP ${response.status}: ${payload.message ?? 'unknown error'}`)
  return payload.data
}

function requireInstalledTheme(result: ThemeRecord | undefined, label: string): void {
  const sourceManifest = JSON.parse(readFileSync(join(workspace, 'komari-theme.json'), 'utf8')) as { version?: unknown }
  if (result?.short !== 'Transit' || result.version !== sourceManifest.version)
    throw new Error(`${label} did not return the installed Transit manifest`)
  validateInstalledTheme()
}

async function uploadLegacyTheme(baseUrl: string, zipPath: string, label: string): Promise<void> {
  const archive = new Blob([new Uint8Array(readFileSync(zipPath))], { type: 'application/zip' })
  const response = await fetch(`${baseUrl}/api/admin/theme/upload`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', 'cookie': sessionCookie },
    body: archive,
  })
  requireInstalledTheme(await readApiResponse<ThemeRecord>(response, label), label)
}

async function uploadChunkedTheme(baseUrl: string, zipPath: string, label: string): Promise<void> {
  const archive = new Uint8Array(readFileSync(zipPath))
  const initResponse = await fetch(`${baseUrl}/api/admin/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cookie': sessionCookie },
    body: JSON.stringify({ purpose: 'theme', size: archive.byteLength, filename: basename(zipPath) }),
  })
  const initialized = await readApiResponse<{ chunk_size?: unknown, upload_id?: unknown }>(initResponse, `${label} init`)
  const uploadID = initialized?.upload_id
  if (typeof uploadID !== 'string' || initialized?.chunk_size !== CHUNK_SIZE)
    throw new Error(`${label} returned an invalid chunk upload configuration`)

  const totalChunks = Math.ceil(archive.byteLength / CHUNK_SIZE)
  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, archive.byteLength)
    const chunk = archive.slice(start, end)
    const form = new FormData()
    form.append('upload_id', uploadID)
    form.append('chunk_index', String(index))
    form.append('chunk_data', new Blob([chunk]), `chunk-${index}`)
    const chunkResponse = await fetch(`${baseUrl}/api/admin/upload/chunk`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
      body: form,
    })
    await readApiResponse(chunkResponse, `${label} chunk ${index}`)
  }

  const mergeResponse = await fetch(`${baseUrl}/api/admin/upload/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cookie': sessionCookie },
    body: JSON.stringify({ upload_id: uploadID }),
  })
  requireInstalledTheme(await readApiResponse<ThemeRecord>(mergeResponse, `${label} merge`), label)
}

async function uploadTheme(baseUrl: string, zipPath: string, label: string): Promise<void> {
  if (spec.themeUpload === 'chunked') {
    await uploadChunkedTheme(baseUrl, zipPath, label)
    return
  }
  await uploadLegacyTheme(baseUrl, zipPath, label)
}

async function rpc<T>(baseUrl: string, method: string, params: Record<string, unknown> = {}, authenticated = true): Promise<RpcResponse<T>> {
  const id = ++rpcId
  const response = await fetch(`${baseUrl}/api/rpc2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (!response.ok)
    throw new Error(`${method} returned HTTP ${response.status}`)
  const payload = await response.json() as RpcResponse<T> & { id?: unknown, jsonrpc?: unknown }
  if (payload.jsonrpc !== '2.0' || payload.id !== id)
    throw new Error(`${method} returned a malformed JSON-RPC envelope`)
  return payload
}

function requireResult<T>(response: RpcResponse<T>, method: string): T {
  if (response.error)
    throw new Error(`${method} failed with RPC ${response.error.code ?? 'unknown'}`)
  if (!('result' in response))
    throw new Error(`${method} omitted its result`)
  return response.result as T
}

async function saveAndVerify(baseUrl: string): Promise<{ first: string, second: string }> {
  const first = requireResult(await rpc<{ uuid: string }>(baseUrl, 'admin:addClient', { name: 'Transit Lab A' }), 'admin:addClient').uuid
  const second = requireResult(await rpc<{ uuid: string }>(baseUrl, 'admin:addClient', { name: 'Transit Lab B' }), 'admin:addClient').uuid
  const denied = await rpc(baseUrl, 'admin:orderClients', { [first]: 1 }, false)
  if (!denied.error)
    throw new Error('Anonymous admin:orderClients was not rejected')
  const write = await rpc(baseUrl, 'admin:orderClients', { [first]: 91, [second]: 17 })
  if (write.error)
    throw new Error(`admin:orderClients failed with RPC ${write.error.code ?? 'unknown'}`)
  const clients = requireResult(await rpc<ClientRecord[]>(baseUrl, 'admin:listClients'), 'admin:listClients')
  if (clients.find(client => client.uuid === first)?.weight !== 91 || clients.find(client => client.uuid === second)?.weight !== 17)
    throw new Error('Client weights were not readable after admin:orderClients')
  return { first, second }
}

interface PingTaskRecord {
  id?: number
  name?: string
  type?: string
  target?: string
  clients?: string[]
  interval?: number
}

/**
 * 拓扑自愈依赖的整组 Ping 任务 RPC 在这个 Komari 版本上是否都在。
 *
 * 单独验证是因为入口任务复用走的是 `admin:editPingTask`（把线路机加进已有任务的
 * clients），而这个方法比另外三个晚出现。主题在它缺失时会退回新建，但「退回」这条
 * 路只有单测覆盖，没有任何证据说明矩阵里最老的版本到底有没有它——不知道就等于
 * 每次改这块都在赌。这里把答案固定下来：存在但语义不符直接失败；缺失时不能只
 * 跳过，实验室要照主题的兜底路径再新建一条
 * 同名任务，并确认第二台真实客户端确实绑定成功。
 */
async function verifyPingTaskRpcSurface(baseUrl: string, clientIds: { first: string, second: string }): Promise<void> {
  const taskName = 'Transit Lab Probe'
  const created = await rpc(baseUrl, 'admin:addPingTask', {
    name: taskName,
    type: 'icmp',
    target: '203.0.113.9',
    clients: [clientIds.first],
    interval: 60,
    default_on: false,
  })
  if (created.error)
    throw new Error(`admin:addPingTask failed with RPC ${created.error.code ?? 'unknown'}`)

  const listed = requireResult(await rpc<PingTaskRecord[]>(baseUrl, 'admin:getAllPingTasks'), 'admin:getAllPingTasks')
  const task = listed.find(entry => entry.name === taskName && entry.clients?.includes(clientIds.first))
  if (!task || !Number.isInteger(task.id))
    throw new Error('entry-task creation path did not return the task just created')

  const edited = await rpc(baseUrl, 'admin:editPingTask', {
    tasks: [{ ...task, clients: [...new Set([...(task.clients ?? []), clientIds.second])] }],
  })
  const taskIds = [task.id!]
  if (edited.error) {
    // 与 ensureTopologyEntryProbeTask 相同：不能把第二台线路机并入既有任务时，
    // 新建一条同名任务兜底。矩阵必须验证兜底真的落库，不能只记 warning 跳过。
    console.warn(`[komari-lab] admin:editPingTask unavailable on ${version} (RPC ${edited.error.code ?? 'unknown'}); the theme falls back to creating a task`)
    const fallback = await rpc(baseUrl, 'admin:addPingTask', {
      name: taskName,
      type: task.type,
      target: task.target,
      clients: [clientIds.second],
      interval: task.interval ?? 60,
      default_on: false,
    })
    if (fallback.error)
      throw new Error(`entry-task fallback creation failed with RPC ${fallback.error.code ?? 'unknown'}`)
    const afterFallback = requireResult(await rpc<PingTaskRecord[]>(baseUrl, 'admin:getAllPingTasks'), 'admin:getAllPingTasks')
    const fallbackTask = afterFallback.find(entry => entry.name === taskName && entry.clients?.includes(clientIds.second))
    if (!fallbackTask || !Number.isInteger(fallbackTask.id))
      throw new Error('entry-task fallback creation reported success but did not persist')
    taskIds.push(fallbackTask.id!)
  }
  else {
    const afterEdit = requireResult(await rpc<PingTaskRecord[]>(baseUrl, 'admin:getAllPingTasks'), 'admin:getAllPingTasks')
    const updated = afterEdit.find(entry => entry.id === task.id)
    if (!updated?.clients?.includes(clientIds.first) || !updated.clients.includes(clientIds.second))
      throw new Error('entry-task reuse path reported success but did not persist both real clients')
  }

  const deleted = await rpc(baseUrl, 'admin:deletePingTask', { id: taskIds })
  if (deleted.error)
    throw new Error(`admin:deletePingTask failed with RPC ${deleted.error.code ?? 'unknown'}`)
  const afterDelete = requireResult(await rpc<PingTaskRecord[]>(baseUrl, 'admin:getAllPingTasks'), 'admin:getAllPingTasks')
  if (afterDelete.some(entry => taskIds.includes(entry.id ?? -1)))
    throw new Error('admin:deletePingTask reported success but a lab task is still listed')
}

async function verifyOrder(baseUrl: string, ids: { first: string, second: string }, label: string): Promise<void> {
  const clients = requireResult(await rpc<ClientRecord[]>(baseUrl, 'admin:listClients'), 'admin:listClients')
  if (clients.find(client => client.uuid === ids.first)?.weight !== 91 || clients.find(client => client.uuid === ids.second)?.weight !== 17)
    throw new Error(`Client order was not preserved ${label}`)
}

async function verifyPublicTheme(baseUrl: string, label: string): Promise<void> {
  const publicResponse = await fetch(`${baseUrl}/api/public`)
  const publicBody = await readApiResponse<{ theme?: string, theme_settings?: { labCanary?: string } }>(publicResponse, 'public settings')
  if (publicBody?.theme !== 'Transit' || publicBody.theme_settings?.labCanary !== themeCanaryValue)
    throw new Error(`Transit theme selection or settings were not preserved ${label}`)
}

async function verifyThemeAndAdminRoutes(baseUrl: string, label: string): Promise<void> {
  const home = await fetch(`${baseUrl}/`)
  if (!home.ok)
    throw new Error(`Transit home returned HTTP ${home.status} ${label}`)
  const html = await home.text()
  const assetPaths = Array.from(html.matchAll(ENTRY_ASSET_PATTERN), match => match[1])
  if (!assetPaths.length)
    throw new Error(`Transit home did not reference any entry assets ${label}`)
  for (const assetPath of assetPaths) {
    const asset = await fetch(new URL(assetPath, baseUrl))
    if (!asset.ok)
      throw new Error(`Transit entry asset ${assetPath} returned HTTP ${asset.status} ${label}`)
  }

  const admin = await fetch(`${baseUrl}/admin/servers`, {
    headers: { cookie: sessionCookie },
    redirect: 'manual',
  })
  if (admin.status !== 200) {
    const location = admin.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(admin.status) || location !== '/admin/servers')
      throw new Error(`Komari admin server route returned HTTP ${admin.status} to ${location ?? 'no location'} ${label}`)
    const followed = await fetch(new URL(location, baseUrl), { headers: { cookie: sessionCookie } })
    if (!followed.ok)
      throw new Error(`Komari admin server redirect returned HTTP ${followed.status} ${label}`)
  }
}

async function verifyThemeInBrowser(baseUrl: string, label: string): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const failures: string[] = []
    page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('api.iconify.design'))
        failures.push(`console: ${message.text()}`)
    })
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin === baseUrl && response.status() >= 400)
        failures.push(`HTTP ${response.status()}: ${url.pathname}`)
    })

    await page.route('https://api.iconify.design/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prefix: 'lab', icons: {} }),
    }))
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#app > *').first().waitFor({ state: 'visible', timeout: 15_000 })
    const renderedText = (await page.locator('#app').textContent())?.trim() ?? ''
    if (!renderedText)
      throw new Error(`Transit mounted without visible content ${label}`)
    await page.waitForTimeout(500)
    if (failures.length)
      throw new Error(`Transit browser smoke failed ${label}: ${failures.join('; ')}`)
  }
  finally {
    await browser.close()
  }
}

async function verifyRestartPersistence(baseUrl: string, ids: { first: string, second: string }): Promise<void> {
  await login(baseUrl)
  await verifyOrder(baseUrl, ids, 'after a Komari restart')
  await verifyPublicTheme(baseUrl, 'after a Komari restart')
  if (readFileSync(rollbackMarker, 'utf8') !== rollbackMarkerValue)
    throw new Error('The verified Transit rollback snapshot was not restored')
}

async function enableTheme(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/admin/theme/set?theme=Transit`, {
    headers: { cookie: sessionCookie },
  })
  if (!response.ok)
    throw new Error(`Theme activation failed with HTTP ${response.status}`)
  const settings = await fetch(`${baseUrl}/api/admin/theme/settings?theme=Transit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cookie': sessionCookie },
    body: JSON.stringify({ rpcTransportMode: 'http', labCanary: themeCanaryValue }),
  })
  await readApiResponse(settings, 'Theme settings write')
  await verifyPublicTheme(baseUrl, 'immediately after configuration')
}

function createRollbackSnapshot(): void {
  writeFileSync(rollbackMarker, rollbackMarkerValue)
  mkdirSync(resolve(rollbackDir, '..'), { recursive: true })
  cpSync(themeDir, rollbackDir, { recursive: true, errorOnExist: true })
  if (readFileSync(join(rollbackDir, basename(rollbackMarker)), 'utf8') !== rollbackMarkerValue)
    throw new Error('Could not verify the Transit rollback snapshot')
}

function restoreRollbackSnapshot(): void {
  if (!existsSync(themeDir) || !existsSync(rollbackDir))
    throw new Error('Transit rollback paths are missing')
  renameSync(themeDir, displacedThemeDir)
  try {
    renameSync(rollbackDir, themeDir)
  }
  catch (error) {
    renameSync(displacedThemeDir, themeDir)
    throw error
  }
  validateInstalledTheme()
  if (readFileSync(rollbackMarker, 'utf8') !== rollbackMarkerValue)
    throw new Error('Transit rollback marker was not restored')
}

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true })
  await downloadBinary()
  const zipPath = findReleaseZip()
  const port = await availablePort()
  let baseUrl = await startServer(port)
  if (!spec.usesInstallGuide) {
    await stopServer()
    resetLegacyPassword()
    baseUrl = await startServer(port)
  }
  await login(baseUrl)
  await uploadTheme(baseUrl, zipPath, 'Initial theme installation')
  await enableTheme(baseUrl)
  await verifyThemeAndAdminRoutes(baseUrl, 'after initial installation')
  await verifyThemeInBrowser(baseUrl, 'after initial installation')
  const ids = await saveAndVerify(baseUrl)
  await verifyPingTaskRpcSurface(baseUrl, ids)
  await verifyRouteProbeLab({ baseUrl, version, workspace, dataDir, client: ids.first, cookie: () => sessionCookie, restart: async () => {
    await stopServer()
    await startServer(port)
    await login(baseUrl)
  } })
  createRollbackSnapshot()
  await uploadTheme(baseUrl, zipPath, 'Same-package theme upgrade')
  if (existsSync(rollbackMarker))
    throw new Error('Same-package theme upgrade did not replace the existing Transit directory')
  await verifyOrder(baseUrl, ids, 'after a same-package theme upgrade')
  await verifyPublicTheme(baseUrl, 'after a same-package theme upgrade')
  await verifyThemeAndAdminRoutes(baseUrl, 'after a same-package theme upgrade')
  await verifyThemeInBrowser(baseUrl, 'after a same-package theme upgrade')
  await stopServer()
  restoreRollbackSnapshot()
  baseUrl = await startServer(port)
  await verifyRestartPersistence(baseUrl, ids)
  await verifyThemeAndAdminRoutes(baseUrl, 'after rollback and restart')
  await verifyThemeInBrowser(baseUrl, 'after rollback and restart')
  console.log(`Komari ${version} compatibility passed: real theme install, browser execution, routes/assets, same-package upgrade, rollback, auth boundary, RPC and restart persistence`)
}

try {
  await main()
}
finally {
  await stopServer()
}
