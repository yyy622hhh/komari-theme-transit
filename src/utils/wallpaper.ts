export type PersonalWallpaperEffect = 'glass' | 'blur' | 'hd'

export const PERSONAL_WALLPAPER_MAX_BYTES = 15 * 1024 * 1024
export const PERSONAL_WALLPAPER_MAX_PIXELS = 50_000_000

const SUPPORTED_WALLPAPER_TYPES = new Set([
  'image/avif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export function parsePersonalWallpaperEffect(value: unknown): PersonalWallpaperEffect {
  return value === 'glass' || value === 'blur' || value === 'hd' ? value : 'glass'
}

export function validateWallpaperFileMetadata(file: Pick<File, 'size' | 'type'>): void {
  if (!SUPPORTED_WALLPAPER_TYPES.has(file.type.toLowerCase()))
    throw new Error('仅支持 JPG、PNG、WebP 或 AVIF 图片。')
  if (file.size <= 0)
    throw new Error('壁纸文件为空，请重新选择。')
  if (file.size > PERSONAL_WALLPAPER_MAX_BYTES)
    throw new Error('壁纸不能超过 15 MB。')
}

export function validateWallpaperDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('无法读取壁纸尺寸。')
  if (width * height > PERSONAL_WALLPAPER_MAX_PIXELS)
    throw new Error('壁纸分辨率过大，请使用不超过 5000 万像素的图片。')
}

export function formatWallpaperFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 KB'
  if (bytes < 1024 * 1024)
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
