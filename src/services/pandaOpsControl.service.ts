import type { PandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializePandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'

interface SavePandaOpsNodeControlsOptions {
  theme: string
  themeSettings: Record<string, unknown>
  controls: PandaOpsNodeControls
}

export async function savePandaOpsNodeControls(options: SavePandaOpsNodeControlsOptions): Promise<Record<string, unknown>> {
  const payload = {
    ...options.themeSettings,
    pandaOpsNodeControls: serializePandaOpsNodeControls(options.controls),
  }

  return saveManagedThemeSettings({
    theme: options.theme,
    settings: payload,
    permission: 'nodeTopology',
    requestKey: `panda-ops:node-controls:${options.theme}`,
  })
}
