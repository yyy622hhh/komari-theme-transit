import { emojiToRegionMap } from '@/utils/regionData'

export { emojiToRegionMap }

const REGION_FLAG_REGEX = /[\u{1F1E0}-\u{1F1FF}]{2}/gu

interface RegionEntry { emoji: string, en: string, zh: string, code: string, aliases: string[] }

const CJK_UNIFIED_IDEOGRAPH_REGEX = /\p{Script=Han}/u

function getRegionEntry(region: string | null | undefined): RegionEntry | null {
  if (!region?.trim())
    return null

  const trimmed = region.trim()
  const direct = emojiToRegionMap[trimmed]
  if (direct)
    return { emoji: trimmed, en: direct.en, zh: direct.zh, code: direct.code, aliases: direct.aliases }

  const lowerRegion = trimmed.toLowerCase()
  for (const [emoji, info] of Object.entries(emojiToRegionMap)) {
    if (info.code.toLowerCase() === lowerRegion || info.aliases.some(alias => alias.toLowerCase() === lowerRegion))
      return { emoji, en: info.en, zh: info.zh, code: info.code, aliases: info.aliases }
  }

  return null
}

/**
 * 检查地区emoji是否匹配搜索词
 * @param regionEmoji 地区emoji（如：🇭🇰）
 * @param searchTerm 搜索词
 * @returns 是否匹配
 */
export function isRegionMatch(regionEmoji: string, searchTerm: string): boolean {
  const lowerSearchTerm = searchTerm.toLowerCase().trim()

  // 直接匹配emoji / 原始值，保留未知地区的搜索能力
  if (regionEmoji === searchTerm)
    return true

  const regionInfo = getRegionEntry(regionEmoji)
  if (!regionInfo)
    return regionEmoji.toLowerCase().includes(lowerSearchTerm)

  // 检查英文名称
  if (regionInfo.en.toLowerCase().includes(lowerSearchTerm))
    return true

  // 检查中文名称
  if (regionInfo.zh.includes(lowerSearchTerm))
    return true

  // 检查别名
  return regionInfo.aliases.some(alias =>
    alias.toLowerCase().includes(lowerSearchTerm),
  )
}

/**
 * 获取地区的显示名称
 * @param regionEmoji 地区emoji
 * @param language 语言 ('en' | 'zh')
 * @returns 地区名称
 */
export function getRegionDisplayName(regionEmoji: string, language: 'en' | 'zh' = 'zh'): string {
  const regionInfo = getRegionEntry(regionEmoji)
  if (!regionInfo)
    return ''

  if (language === 'en')
    return regionInfo.en

  return CJK_UNIFIED_IDEOGRAPH_REGEX.test(regionInfo.zh) ? regionInfo.zh : ''
}

/**
 * 获取所有支持的地区emoji列表
 * @returns 地区emoji数组
 */
export function getSupportedRegions(): string[] {
  return Object.keys(emojiToRegionMap)
}

/**
 * 获取地区代码
 * @param regionEmoji 地区emoji
 * @returns 地区代码（如：HK, CN, US）
 */
export function getRegionCode(regionEmoji: string): string {
  const regionInfo = getRegionEntry(regionEmoji)
  if (!regionInfo)
    return regionEmoji

  return regionInfo.code
}

/**
 * 根据地区代码获取emoji
 * @param code 地区代码（如：HK, CN, US）
 * @returns 地区emoji
 */
export function getEmojiByCode(code: string): string {
  const upperCode = code.toUpperCase()
  for (const [emoji, info] of Object.entries(emojiToRegionMap)) {
    if (info.code === upperCode) {
      return emoji
    }
  }
  return code
}

/**
 * 根据搜索词查找匹配的地区
 * @param searchTerm 搜索词
 * @returns 匹配的地区信息数组
 */
export function searchRegions(searchTerm: string): Array<{ emoji: string, en: string, zh: string, code: string }> {
  const results: Array<{ emoji: string, en: string, zh: string, code: string }> = []
  const lowerSearchTerm = searchTerm.toLowerCase().trim()

  for (const [emoji, info] of Object.entries(emojiToRegionMap)) {
    if (isRegionMatch(emoji, lowerSearchTerm)) {
      results.push({
        emoji,
        en: info.en,
        zh: info.zh,
        code: info.code,
      })
    }
  }

  return results
}

/**
 * 根据别名或代码获取地区信息
 * @param aliasOrCode 别名或代码（如：hk, HK, 香港, hongkong）
 * @returns 地区信息，如果未找到则返回 null
 */
export function getRegionByAlias(aliasOrCode: string): { emoji: string, en: string, zh: string, code: string } | null {
  const regionInfo = getRegionEntry(aliasOrCode)
  if (!regionInfo)
    return null

  return { emoji: regionInfo.emoji, en: regionInfo.en, zh: regionInfo.zh, code: regionInfo.code }
}

/**
 * 从文本中提取地区emoji
 * @param text 包含地区emoji的文本
 * @returns 提取到的地区emoji数组
 */
export function extractRegionEmojis(text: string): string[] {
  const emojis: string[] = []
  // 匹配国旗emoji（由两个区域指示符字符组成）
  const matches = text.match(REGION_FLAG_REGEX)

  if (matches) {
    for (const match of matches) {
      if (emojiToRegionMap[match]) {
        emojis.push(match)
      }
    }
  }

  return emojis
}
