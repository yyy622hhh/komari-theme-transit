import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { RouteProbeResults } from '@/utils/routeProbeResults'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import {
  mergeRouteProbeResults,
  normalizeRouteProbeResults,
  ROUTE_PROBE_RESULTS_SETTING,
  stripNodeRouteTags,
} from '@/utils/routeProbeResults'
import { parseNodeRouteTag } from '@/utils/routeTag'
import { getSharedRpc } from '@/utils/rpc'

interface SaveRouteProbeResultsOptions {
  theme: string
  results: RouteProbeResults
  activeNodeIds?: readonly string[]
  onPublicSettings?: PublicSettingsUpdater
}

/**
 * Remove legacy metadata only from a snapshot fetched after the durable save.
 * Komari edits the complete tag string and has no revision/CAS parameter, so
 * every cleanup must fetch this node immediately before its own write instead
 * of reusing a batch snapshot captured while another node was being handled.
 */
export async function cleanupPersistedLegacyRouteTag(uuid: string, persistedTag: string): Promise<string | null> {
  const latestClient = (await getSharedRpc().getNodesOverHttp())[uuid]
  if (!latestClient || typeof latestClient.tags !== 'string')
    return '写回后未找到节点最新信息，旧标签将在下次打开首页时重试清理'

  const latestTags = latestClient.tags
  const legacy = parseNodeRouteTag(latestTags)
  if (!legacy)
    return null

  const persisted = parseNodeRouteTag(persistedTag)
  if (!persisted || (persisted.measuredAt ?? 0) < (legacy.measuredAt ?? 0))
    return '节点旧标签比已保存结果更新，已保留标签并等待重新采集'

  const cleanedTags = stripNodeRouteTags(latestTags)
  if (cleanedTags !== latestTags.trim())
    await getSharedRpc().editClient({ uuid, tags: cleanedTags })
  return null
}

/** Merge route evidence against the latest server snapshot under the shared theme lock. */
export async function saveRouteProbeResults(options: SaveRouteProbeResultsOptions): Promise<RouteProbeResults> {
  if (!options.theme.trim())
    throw new Error('当前主题信息未加载，无法保存回程结果。')

  const saved = await saveManagedThemeSettings({
    theme: options.theme,
    patch: currentSettings => ({
      [ROUTE_PROBE_RESULTS_SETTING]: JSON.stringify(mergeRouteProbeResults(
        normalizeRouteProbeResults(currentSettings[ROUTE_PROBE_RESULTS_SETTING]),
        normalizeRouteProbeResults(options.results),
        options.activeNodeIds,
      )),
    }),
    permission: 'advancedTools',
    requestKey: `route-probe-results:${options.theme}`,
    onPublicSettings: options.onPublicSettings,
  })
  return normalizeRouteProbeResults(saved[ROUTE_PROBE_RESULTS_SETTING])
}
