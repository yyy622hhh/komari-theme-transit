/** ECharts HTML formatters bypass Vue's text escaping. Escape each dynamic text/attribute. */
export function escapeTooltipHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[character]!)
}

/** Chart palettes use hex/rgb colors; never interpolate arbitrary CSS into an HTML attribute. */
export function safeTooltipColor(value: unknown): string {
  if (typeof value !== 'string')
    return '#94a3b8'
  return /^(?:#[a-f\d]{3,4}|#[a-f\d]{6}|#[a-f\d]{8}|rgba?\([\d.,%\s]+\))$/i.test(value)
    ? value
    : '#94a3b8'
}
