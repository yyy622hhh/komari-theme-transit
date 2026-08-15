import type { PandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializePandaOpsNodeControls } from '@/utils/pandaOpsNodeControl'

interface SavePandaOpsNodeControlsOptions {
  theme: string
  controls: PandaOpsNodeControls
}

export async function savePandaOpsNodeControls(options: SavePandaOpsNodeControlsOptions): Promise<Record<string, unknown>> {
  const patch = {
    pandaOpsNodeControls: serializePandaOpsNodeControls(options.controls),
  }

  return saveManagedThemeSettings({
    theme: options.theme,
    patch,
    permission: 'nodeTopology',
    requestKey: `panda-ops:node-controls:${options.theme}`,
  })
}
