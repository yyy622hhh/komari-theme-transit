import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializeTopologyConfig } from '@/utils/topologyConfig'
import { getTopologyCreatedTaskIds, serializeTopologyOwnedPingTaskIds } from '@/utils/topologyCreatedTasks'
import { validateTopologyRoutes } from '@/utils/topologyHelper'
import { serializeTopologyRoutes } from '@/utils/topologyLegacyFormat'

interface SaveTopologyOptions {
  theme: string
  routes: TopologyRouteConfig[]
  expected?: Record<string, unknown>
  lockHeld?: boolean
  onPublicSettings?: PublicSettingsUpdater
}

/** POST 已经落到服务器、本地 expected 已切到这份快照。调用方不得再按「绑定没落盘」去删 Ping 任务。 */
export class TopologySaveCommittedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TopologySaveCommittedError'
  }
}

export function isTopologySaveCommittedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TopologySaveCommittedError'
}

/** CAS 快照：JSON 真值有才盯，避免 mock 缺字段被当成「键必须不存在」。 */
export function topologyExpectedFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(Object.hasOwn(payload, 'topologyConfig') ? { topologyConfig: payload.topologyConfig } : {}),
    topologyRoute: payload.topologyRoute,
    topologyMetrics: payload.topologyMetrics,
    ...(Object.hasOwn(payload, 'topologyOwnedPingTaskIds')
      ? { topologyOwnedPingTaskIds: payload.topologyOwnedPingTaskIds }
      : {}),
  }
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
