import type { PublicSettingsUpdater } from '@/services/theme-settings.service'
import type { NodeCardPanelConfigs } from '@/utils/nodeCardPanel'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { mergeNodeCardPanelConfigs } from '@/utils/nodeCardPanel'

interface SaveNodeCardPanelConfigsOptions {
  theme: string
  /**
   * 同 `saveNodeControls`：`nodeCardPanels` 也是整块覆盖的单键，必须在服务端当前
   * 映射之上做增量修改，否则会覆盖别的会话设置的逐节点面板。
   */
  apply: (current: NodeCardPanelConfigs) => NodeCardPanelConfigs
  onPublicSettings?: PublicSettingsUpdater
}

export async function saveNodeCardPanelConfigs(options: SaveNodeCardPanelConfigsOptions): Promise<Record<string, unknown>> {
  return saveManagedThemeSettings({
    theme: options.theme,
    patch: currentSettings => ({
      nodeCardPanels: JSON.stringify(
        mergeNodeCardPanelConfigs(currentSettings.nodeCardPanels, options.apply),
      ),
    }),
    permission: 'nodeCardPanel',
    requestKey: `node-card-panels:${options.theme}`,
    onPublicSettings: options.onPublicSettings,
  })
}
