import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
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
  const serialized = serializeTopologyRoutes(options.routes)
  if (!serialized.topologyRoute)
    throw new Error('至少保留一条包含入口和目标节点的线路。')

  const payload = {
    ...options.themeSettings,
    topologyEnabled: true,
    ...serialized,
  }

  return saveManagedThemeSettings({
    theme: options.theme,
    settings: payload,
    permission: 'nodeTopology',
    requestKey: getSaveKey(options.theme),
  })
}
