import { describe, expect, test } from 'bun:test'
import {
  formatWallpaperFileSize,
  parsePersonalWallpaperEffect,
  PERSONAL_WALLPAPER_MAX_BYTES,
  validateWallpaperDimensions,
  validateWallpaperFileMetadata,
} from '../../src/utils/wallpaper'

describe('personal wallpaper validation', () => {
  test('accepts supported image metadata within the storage limit', () => {
    expect(() => validateWallpaperFileMetadata({ type: 'image/webp', size: 2 * 1024 * 1024 })).not.toThrow()
    expect(() => validateWallpaperDimensions(7680, 4320)).not.toThrow()
  })

  test('rejects unsupported, empty and oversized files', () => {
    expect(() => validateWallpaperFileMetadata({ type: 'image/svg+xml', size: 1024 })).toThrow('仅支持')
    expect(() => validateWallpaperFileMetadata({ type: 'image/png', size: 0 })).toThrow('文件为空')
    expect(() => validateWallpaperFileMetadata({ type: 'image/jpeg', size: PERSONAL_WALLPAPER_MAX_BYTES + 1 })).toThrow('15 MB')
  })

  test('rejects invalid or excessive decoded dimensions', () => {
    expect(() => validateWallpaperDimensions(0, 1080)).toThrow('无法读取')
    expect(() => validateWallpaperDimensions(10_000, 6_000)).toThrow('5000 万像素')
  })

  test('normalizes effects and formats file sizes', () => {
    expect(parsePersonalWallpaperEffect('blur')).toBe('blur')
    expect(parsePersonalWallpaperEffect('hd')).toBe('hd')
    expect(parsePersonalWallpaperEffect('unknown')).toBe('glass')
    expect(formatWallpaperFileSize(512 * 1024)).toBe('512 KB')
    expect(formatWallpaperFileSize(2.25 * 1024 * 1024)).toBe('2.3 MB')
  })
})
