import type { NodeCardPanelConfigs } from '@/utils/nodeCardPanel'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializeNodeCardPanelConfigs } from '@/utils/nodeCardPanel'

interface SaveNodeCardPanelConfigsOptions {
  theme: string
  configs: NodeCardPanelConfigs
}

export async function saveNodeCardPanelConfigs(options: SaveNodeCardPanelConfigsOptions): Promise<Record<string, unknown>> {
  return saveManagedThemeSettings({
    theme: options.theme,
    patch: { nodeCardPanels: serializeNodeCardPanelConfigs(options.configs) },
    permission: 'nodeCardPanel',
    requestKey: `node-card-panels:${options.theme}`,
  })
}
