import type { PermissionKey } from '@/services/auth.service'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import { getSharedApi } from '@/utils/api'

interface SaveThemeSettingsOptions {
  theme: string
  patch: Record<string, unknown>
  permission: PermissionKey
  requestKey: string
}

const themeSaveTails = new Map<string, Promise<void>>()

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
  let savedSettings: Record<string, unknown> = {}
  await serializeThemeSave(options.theme, async () => {
    // Revalidate only after older saves finish. A queued mutation must not use
    // an authentication decision made before it waited.
    const permission = await requirePermission(options.permission, { force: true })
    if (!permission.granted)
      throw new Error('登录状态已过期，请重新登录后保存。')

    const theme = encodeURIComponent(options.theme)
    await requestManager.run(options.requestKey, async (signal) => {
      // Komari's endpoint replaces the complete settings object. Fetch the
      // current server value immediately before saving so a second tab or the
      // official admin UI cannot be overwritten by this page's stale snapshot.
      const current = await getSharedApi().getPublicSettings(signal)
      if (current.theme !== options.theme)
        throw new Error('当前主题已改变，请刷新页面后重试。')
      savedSettings = {
        ...(current.theme_settings ?? {}),
        ...options.patch,
      }
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
  })

  return savedSettings
}
