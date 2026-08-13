import type { PandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import { serializePandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'

interface SavePandaOpsNodeControlsOptions {
  theme: string
  themeSettings: Record<string, unknown>
  controls: PandaOpsNodeControls
}

export async function savePandaOpsNodeControls(options: SavePandaOpsNodeControlsOptions): Promise<Record<string, unknown>> {
  const permission = await requirePermission('nodeTopology', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后保存。')

  const payload = {
    ...options.themeSettings,
    pandaOpsNodeControls: serializePandaOpsNodeControls(options.controls),
  }

  await requestManager.run(
    `panda-ops:node-controls:${options.theme}`,
    async (signal) => {
      const response = await fetch(`/api/admin/theme/config?short=${encodeURIComponent(options.theme)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { message?: string } | null
        throw new Error(result?.message || `保存失败（HTTP ${response.status}）`)
      }
    },
    { retryAttempts: 0 },
  )
  return payload
}
