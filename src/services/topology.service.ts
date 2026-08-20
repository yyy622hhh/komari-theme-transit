import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
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

  const serialized = serializeTopologyRoutes(options.routes)

  const patch = {
    topologyEnabled: true,
    ...serialized,
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
