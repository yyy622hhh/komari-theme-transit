import type { PermissionKey } from '@/services/auth.service'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import { getSharedApi } from '@/utils/api'
import { validateServerThemeSettings, validateThemeSettings } from '@/utils/themeSettings'

interface SaveThemeSettingsOptions {
  theme: string
  patch: Record<string, unknown>
  permission: PermissionKey
  requestKey: string
}

const themeSaveTails = new Map<string, Promise<void>>()

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
  return Object.entries(patch).every(([key, value]) => (
    Object.hasOwn(settings, key) && stableJson(settings[key]) === stableJson(value)
  ))
}

async function withCrossTabThemeLock<T>(theme: string, save: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    return save()
  return navigator.locks.request(`transit:theme-settings:${theme}`, save)
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
  const patch = validateThemeSettings(options.patch)
  let savedSettings: Record<string, unknown> = {}
  await withCrossTabThemeLock(options.theme, () => serializeThemeSave(options.theme, async () => {
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
      savedSettings = {
        ...validateServerThemeSettings(current.theme_settings),
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
    if (persisted.theme !== options.theme || !persistedPatchMatches(validateServerThemeSettings(persisted.theme_settings), patch))
      throw new Error('服务器未保留本次主题配置，请刷新后重试。')
  }))

  return savedSettings
}
