import type { NodeControls } from '@/utils/nodeControl'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { serializeNodeControls } from '@/utils/nodeControl'

interface SaveNodeControlsOptions {
  theme: string
  controls: NodeControls
}

export async function saveNodeControls(options: SaveNodeControlsOptions): Promise<Record<string, unknown>> {
  const patch = {
    // Persisted Komari key. Renaming would drop existing maintenance/silence state.
    pandaOpsNodeControls: serializeNodeControls(options.controls),
  }

  return saveManagedThemeSettings({
    theme: options.theme,
    patch,
    permission: 'nodeTopology',
    requestKey: `node-controls:${options.theme}`,
  })
}
