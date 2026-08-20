import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { NodeControls } from '@/utils/nodeControl'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { mergeNodeControls } from '@/utils/nodeControl'

interface SaveNodeControlsOptions {
  theme: string
  /**
   * 在服务端当前的映射之上做增量修改。不要传入本地映射：`pandaOpsNodeControls`
   * 是整块覆盖的单键，本地副本可能已经落后于别的会话，直接写会丢掉它们的改动。
   */
  apply: (current: NodeControls) => NodeControls
  onPublicSettings?: PublicSettingsUpdater
}

export async function saveNodeControls(options: SaveNodeControlsOptions): Promise<Record<string, unknown>> {
  return saveManagedThemeSettings({
    theme: options.theme,
    patch: currentSettings => ({
      // Persisted Komari key. Renaming would drop existing maintenance/silence state.
      pandaOpsNodeControls: JSON.stringify(
        mergeNodeControls(currentSettings.pandaOpsNodeControls, options.apply),
      ),
    }),
    permission: 'nodeTopology',
    requestKey: `node-controls:${options.theme}`,
    onPublicSettings: options.onPublicSettings,
  })
}
