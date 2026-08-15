import { describe, expect, test } from 'bun:test'
import { sanitizeMarkdownUrl } from '../../src/utils/markdown'

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
