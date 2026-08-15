import type { PermissionKey } from '@/services/auth.service'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'

interface SaveThemeSettingsOptions {
  theme: string
  settings: Record<string, unknown>
  permission: PermissionKey
  requestKey: string
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
    body: JSON.stringify(settings),
    signal,
  })
}

export async function saveManagedThemeSettings(options: SaveThemeSettingsOptions): Promise<Record<string, unknown>> {
  const permission = await requirePermission(options.permission, { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后保存。')

  const theme = encodeURIComponent(options.theme)
  await requestManager.run(
    options.requestKey,
    async (signal) => {
      const currentResponse = await sendThemeSettings(
        `/api/admin/theme/settings?theme=${theme}`,
        'POST',
        options.settings,
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
        options.settings,
        signal,
      )
      if (!legacyResponse.ok)
        throw new Error(await readErrorMessage(legacyResponse))
    },
    { retryAttempts: 0 },
  )

  return options.settings
}
