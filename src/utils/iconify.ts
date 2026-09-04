/** Register the generated local icon collection before the app mounts. */
export async function setupIconify(): Promise<void> {
  const { registerBundledIcons } = await import('./iconify.icons')
  registerBundledIcons()
}
