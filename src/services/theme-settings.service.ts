import type { PermissionKey } from '@/services/auth.service'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import { getSharedApi } from '@/utils/api'
import { validateServerThemeSettings, validateThemeSettings } from '@/utils/themeSettings'

/**
 * 补丁可以是一个读取服务端当前配置的函数。按节点存储的映射（维护状态、卡片面板）
 * 必须用它：这些键会被整块覆盖，而本地映射派生自 `publicSettings`，后者只在启动
 * 和窗口重新聚焦时刷新，直接写本地映射会把别的会话在此期间的改动一并抹掉。
 */
type ThemeSettingsPatch
  = | Record<string, unknown>
    | ((currentSettings: Record<string, unknown>) => Record<string, unknown>)

interface SaveThemeSettingsOptions {
  theme: string
  patch: ThemeSettingsPatch
  expected?: Record<string, unknown>
  permission: PermissionKey
  requestKey: string
  lockHeld?: boolean
}

const themeSaveTails = new Map<string, Promise<void>>()
const EXPECTED_MISSING = Symbol('transit expected missing theme setting')

export function createThemeSettingsSnapshot(settings: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [
    key,
    Object.hasOwn(settings, key) ? settings[key] : EXPECTED_MISSING,
  ]))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function persistedPatchMatches(settings: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, value]) => {
    const exists = Object.hasOwn(settings, key)
    if (value === EXPECTED_MISSING)
      return !exists
    return exists && stableJson(settings[key]) === stableJson(value)
  })
}

export async function withManagedThemeSettingsLock<T>(theme: string, save: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    return save()
  return navigator.locks.request(`transit:theme-settings:${theme}`, save)
}

export async function assertManagedThemeSettingsCurrent(options: Pick<SaveThemeSettingsOptions, 'theme' | 'expected' | 'permission'>): Promise<void> {
  const permission = await requirePermission(options.permission, { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后保存。')
  const current = await getSharedApi().getPublicSettings()
  if (current.theme !== options.theme)
    throw new Error('当前主题已改变，请刷新页面后重试。')
  const currentSettings = validateServerThemeSettings(current.theme_settings)
  if (options.expected && !persistedPatchMatches(currentSettings, options.expected))
    throw new Error('拓扑配置已被其他会话修改，请重新打开管理器后再保存。')
}

async function serializeThemeSave<T>(theme: string, save: () => Promise<T>): Promise<T> {
  const previous = themeSaveTails.get(theme) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => turn)
  themeSaveTails.set(theme, tail)

  await previous.catch(() => {})
  try {
    return await save()
  }
  finally {
    release()
    if (themeSaveTails.get(theme) === tail)
      themeSaveTails.delete(theme)
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const result = await response.json().catch(() => null) as { message?: string } | null
  return result?.message || `保存失败（HTTP ${response.status}）`
}

async function sendThemeSettings(
  url: string,
  method: 'POST' | 'PUT',
  settings: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(settings),
    signal,
  })
}

export async function saveManagedThemeSettings(options: SaveThemeSettingsOptions): Promise<Record<string, unknown>> {
  // 函数式补丁要等拿到服务端快照后才能求值，所以这里先留空，在 GET 之后填充。
  let patch: Record<string, unknown> = typeof options.patch === 'function'
    ? {}
    : validateThemeSettings(options.patch)
  let savedSettings: Record<string, unknown> = {}
  const runSave = () => serializeThemeSave(options.theme, async () => {
    // Revalidate only after older saves finish. A queued mutation must not use
    // an authentication decision made before it waited.
    const permission = await requirePermission(options.permission, { force: true })
    if (!permission.granted)
      throw new Error('登录状态已过期，请重新登录后保存。')

    const theme = encodeURIComponent(options.theme)
    await requestManager.run(options.requestKey, async (signal) => {
      // Komari's endpoint replaces the complete settings object. Fetch the
      // current server value immediately before saving. Web Locks serialize
      // Transit tabs; Komari does not expose a revision/CAS API, so an official
      // admin write in this very small GET-to-POST window cannot be detected.
      const current = await getSharedApi().getPublicSettings(signal)
      if (current.theme !== options.theme)
        throw new Error('当前主题已改变，请刷新页面后重试。')
      const currentSettings = validateServerThemeSettings(current.theme_settings)
      if (typeof options.patch === 'function')
        patch = validateThemeSettings(options.patch(currentSettings))
      if (options.expected && !persistedPatchMatches(currentSettings, options.expected))
        throw new Error('拓扑配置已被其他会话修改，请重新打开管理器后再保存。')
      savedSettings = {
        ...currentSettings,
        ...patch,
      }
      savedSettings = validateThemeSettings(savedSettings)
      const currentResponse = await sendThemeSettings(
        `/api/admin/theme/settings?theme=${theme}`,
        'POST',
        savedSettings,
        signal,
      )
      if (currentResponse.ok)
        return

      // Komari 1.4 uses /settings; older installations exposed /config.
      // Only fall back when the route itself is unavailable, never on auth or
      // validation failures that the operator needs to see.
      if (currentResponse.status !== 404 && currentResponse.status !== 405)
        throw new Error(await readErrorMessage(currentResponse))

      const legacyResponse = await sendThemeSettings(
        `/api/admin/theme/config?short=${theme}`,
        'PUT',
        savedSettings,
        signal,
      )
      if (!legacyResponse.ok)
        throw new Error(await readErrorMessage(legacyResponse))
    }, { retryAttempts: 0 })

    const persisted = await getSharedApi().getPublicSettings()
    const persistedSettings = validateServerThemeSettings(persisted.theme_settings)
    if (persisted.theme !== options.theme || !persistedPatchMatches(persistedSettings, patch))
      throw new Error('服务器未保留本次主题配置，请刷新后重试。')
    savedSettings = persistedSettings
  })
  if (options.lockHeld)
    await runSave()
  else
    await withManagedThemeSettingsLock(options.theme, runSave)

  return savedSettings
}
