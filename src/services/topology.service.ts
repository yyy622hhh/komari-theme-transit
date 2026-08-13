import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { requirePermission } from '@/services/auth.service'
import { requestManager } from '@/services/request.service'
import { serializeTopologyRoutes } from '@/utils/topologyHelper'

interface SaveTopologyOptions {
  theme: string
  themeSettings: Record<string, unknown>
  routes: TopologyRouteConfig[]
}

function getSaveKey(theme: string): string {
  return `topology:save:${theme}`
}

export async function saveTopologyConfiguration(options: SaveTopologyOptions): Promise<Record<string, unknown>> {
  const permission = await requirePermission('nodeTopology', { force: true })
  if (!permission.granted)
    throw new Error('登录状态已过期，请重新登录后保存。')

  const serialized = serializeTopologyRoutes(options.routes)
  if (!serialized.topologyRoute)
    throw new Error('至少保留一条包含入口和目标节点的线路。')

  const payload = {
    ...options.themeSettings,
    topologyEnabled: true,
    ...serialized,
  }

  await requestManager.run(
    getSaveKey(options.theme),
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
      return undefined
    },
    { retryAttempts: 0 },
  )
  return payload
}
