import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializeTopologyConfig } from '@/utils/topologyConfig'
import { getTopologyCreatedTaskIds, serializeTopologyOwnedPingTaskIds } from '@/utils/topologyCreatedTasks'
import { serializeTopologyRoutes, validateTopologyRoutes } from '@/utils/topologyHelper'

interface SaveTopologyOptions {
  theme: string
  routes: TopologyRouteConfig[]
  expected?: Record<string, unknown>
  lockHeld?: boolean
  onPublicSettings?: PublicSettingsUpdater
}

function getSaveKey(theme: string): string {
  return `topology:save:${theme}`
}

export async function saveTopologyConfiguration(options: SaveTopologyOptions): Promise<Record<string, unknown>> {
  const validationErrors = validateTopologyRoutes(options.routes)
  if (validationErrors[0])
    throw new Error(validationErrors[0])

  // 写双份：JSON 是新的真值，旧的两条字符串继续写，好让降级安装或还没升级的
  // 页面不会看到空拓扑。确认没人回滚之后才能停写旧字段。
  const patch = {
    topologyEnabled: true,
    topologyConfig: serializeTopologyConfig(options.routes),
    ...serializeTopologyRoutes(options.routes),
    topologyOwnedPingTaskIds: serializeTopologyOwnedPingTaskIds(getTopologyCreatedTaskIds()),
  }

  return saveManagedThemeSettings({
    theme: options.theme,
    patch,
    expected: options.expected,
    permission: 'nodeTopology',
    requestKey: getSaveKey(options.theme),
    lockHeld: options.lockHeld,
    onPublicSettings: options.onPublicSettings,
  })
}
