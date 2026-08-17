import { _api } from '@iconify/vue'

/**
 * Register locally bundled icons and disable the Iconify API.
 * UI icons are generated from source references by scripts/generate-icon-collection.ts.
 */
export async function setupIconify(): Promise<void> {
  _api.setFetch(async () => {
    throw new Error('Iconify CDN is disabled; add the icon to the local collection.')
  })
  const { registerBundledIcons } = await import('./iconify.icons')
  registerBundledIcons()
}
