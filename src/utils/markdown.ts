const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_DATA_IMAGE_REGEX = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/i

export function sanitizeMarkdownUrl(
  url: string | undefined,
  type: 'link' | 'image',
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): string | undefined {
  if (!url)
    return undefined

  const normalized = url.trim()
  if (!normalized)
    return undefined

  if (type === 'image' && normalized.toLowerCase().startsWith('data:'))
    return SAFE_DATA_IMAGE_REGEX.test(normalized) ? normalized : undefined

  try {
    const parsed = new URL(normalized, origin)
    const protocols = type === 'image' ? SAFE_IMAGE_PROTOCOLS : SAFE_LINK_PROTOCOLS
    return protocols.has(parsed.protocol) ? normalized : undefined
  }
  catch {
    return undefined
  }
}
