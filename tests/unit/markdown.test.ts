import { describe, expect, test } from 'bun:test'
import { parseMarkdown, sanitizeMarkdownUrl } from '../../src/utils/markdown'

describe('sanitizeMarkdownUrl', () => {
  test('allows relative and expected external URLs', () => {
    expect(sanitizeMarkdownUrl('/instance/node-1', 'link')).toBe('/instance/node-1')
    expect(sanitizeMarkdownUrl('https://example.com/image.png', 'image')).toBe('https://example.com/image.png')
    expect(sanitizeMarkdownUrl('mailto:admin@example.com', 'link')).toBe('mailto:admin@example.com')
  })

  test('blocks active URL schemes and non-raster data images', () => {
    expect(sanitizeMarkdownUrl('javascript:alert(1)', 'link')).toBeUndefined()
    expect(sanitizeMarkdownUrl('data:text/html;base64,PGgxPng8L2gxPg==', 'image')).toBeUndefined()
    expect(sanitizeMarkdownUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'image')).toBeUndefined()
  })

  test('allows bounded-protocol raster data images', () => {
    expect(sanitizeMarkdownUrl('data:image/png;base64,iVBORw0KGgo=', 'image')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})

describe('parseMarkdown', () => {
  test('parses supported inline tokens without emitting HTML', () => {
    expect(parseMarkdown('plain **bold** _italic_ `code` [link](https://example.com)\n![alt](/image.png)')).toEqual([
      { type: 'text', content: 'plain ' },
      { type: 'bold', content: 'bold' },
      { type: 'text', content: ' ' },
      { type: 'italic', content: 'italic' },
      { type: 'text', content: ' ' },
      { type: 'code', content: 'code' },
      { type: 'text', content: ' ' },
      { type: 'link', content: 'link', url: 'https://example.com' },
      { type: 'br' },
      { type: 'image', alt: 'alt', url: '/image.png' },
    ])
  })

  test('coalesces long unmatched markup into one text token', () => {
    const input = '['.repeat(20_000)
    expect(parseMarkdown(input)).toEqual([{ type: 'text', content: input }])
  })
})
