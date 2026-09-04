const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_DATA_IMAGE_REGEX = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/i
const IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/y
const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/y
const BOLD_ASTERISK_REGEX = /\*\*([^*]+)\*\*/y
const BOLD_UNDERSCORE_REGEX = /__([^_]+)__/y
const ITALIC_ASTERISK_REGEX = /\*([^*]+)\*/y
const ITALIC_UNDERSCORE_REGEX = /_([^_]+)_/y
const CODE_REGEX = /`([^`]+)`/y
const NEXT_SPECIAL_REGEX = /[![*_`\n]/g

export interface MarkdownToken {
  type: 'text' | 'bold' | 'italic' | 'link' | 'image' | 'code' | 'br'
  content?: string
  url?: string
  alt?: string
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(text)
}

export function parseMarkdown(text: string): MarkdownToken[] {
  if (!text)
    return []

  const tokens: MarkdownToken[] = []
  const pushText = (content: string) => {
    if (!content)
      return
    const previous = tokens.at(-1)
    if (previous?.type === 'text') {
      previous.content = `${previous.content ?? ''}${content}`
      return
    }
    tokens.push({ type: 'text', content })
  }
  let cursor = 0

  while (cursor < text.length) {
    const first = text[cursor]
    const imageMatch = first === '!' ? matchAt(IMAGE_REGEX, text, cursor) : null
    const linkMatch = first === '[' ? matchAt(LINK_REGEX, text, cursor) : null
    const boldMatch = first === '*'
      ? matchAt(BOLD_ASTERISK_REGEX, text, cursor)
      : first === '_' ? matchAt(BOLD_UNDERSCORE_REGEX, text, cursor) : null
    const italicMatch = !boldMatch && first === '*'
      ? matchAt(ITALIC_ASTERISK_REGEX, text, cursor)
      : !boldMatch && first === '_' ? matchAt(ITALIC_UNDERSCORE_REGEX, text, cursor) : null
    const codeMatch = first === '`' ? matchAt(CODE_REGEX, text, cursor) : null
    const matched = imageMatch ?? linkMatch ?? boldMatch ?? italicMatch ?? codeMatch

    if (matched) {
      if (matched === imageMatch)
        tokens.push({ type: 'image', alt: matched[1], url: matched[2] })
      else if (matched === linkMatch)
        tokens.push({ type: 'link', content: matched[1], url: matched[2] })
      else if (matched === boldMatch)
        tokens.push({ type: 'bold', content: matched[1] })
      else if (matched === italicMatch)
        tokens.push({ type: 'italic', content: matched[1] })
      else
        tokens.push({ type: 'code', content: matched[1] })
      cursor = matched.index + matched[0].length
      continue
    }

    if (first === '\n') {
      tokens.push({ type: 'br' })
      cursor += 1
      continue
    }

    NEXT_SPECIAL_REGEX.lastIndex = cursor + 1
    const nextSpecial = NEXT_SPECIAL_REGEX.exec(text)?.index ?? text.length
    pushText(text.slice(cursor, nextSpecial))
    cursor = nextSpecial
  }

  return tokens
}

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
