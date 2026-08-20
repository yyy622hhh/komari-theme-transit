import type {
  ChartDashboardPreset,
  DetailMetricCardPreset,
  GeneralCardPreset,
  HomeQuickControlPreset,
  ThemeSettings,
} from './app.settings.constants'
import type {
  ChartDashboardCardKey,
  ChartDashboardTemplate,
  ColorVisionMode,
  DetailMetricCardKey,
  GeneralCardKey,
  GlassColorPreset,
  GlassCustomColors,
  HomeQuickControlKey,
  ManagedThemeMode,
  NodeListMetadataField,
  ThemeMode,
} from './app.types'
import {
  ALL_CHART_DASHBOARD_CARDS,
  ALL_DETAIL_METRIC_CARD_KEYS,
  ALL_GENERAL_CARD_KEYS,
  ALL_HOME_QUICK_CONTROL_KEYS,
  ALL_NODE_LIST_METADATA_FIELDS,
  CHART_DASHBOARD_LABEL_ALIASES,
  CHART_DASHBOARD_PRESET_ALIASES,
  CHART_DASHBOARD_SLOT_COUNT,
  COLOR_VISION_MODE_ALIASES,
  DEFAULT_CHART_DASHBOARD_CARDS,
  DEFAULT_GLASS_CUSTOM_COLORS,
  DETAIL_METRIC_CARD_LABEL_ALIASES,
  DETAIL_METRIC_CARD_PRESET_ALIASES,
  DETAIL_METRIC_CARD_SLOT_COUNT,
  GENERAL_CARD_LABEL_ALIASES,
  GENERAL_CARD_PRESET_ALIASES,
  GENERAL_CARD_SLOT_COUNT,
  GLASS_COLOR_PRESET_ALIASES,
  HEX_COLOR_REGEX,
  HOME_QUICK_CONTROL_PRESET_ALIASES,
  KEY_LIST_SEPARATOR_REGEX,
} from './app.settings.constants'

export * from './app.settings.constants'

export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark'
}

export function isValidManagedThemeMode(value: unknown): value is ManagedThemeMode {
  return value === 'beijing' || value === 'light' || value === 'dark'
}

export function getBeijingHour(timestamp: number): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(timestamp))

  const parsed = Number.parseInt(hour, 10)
  if (!Number.isFinite(parsed))
    return new Date(timestamp).getHours()

  return parsed === 24 ? 0 : parsed
}

export function isGeneralCardKey(value: string): value is GeneralCardKey {
  return (ALL_GENERAL_CARD_KEYS as readonly string[]).includes(value)
}

export function isDetailMetricCardKey(value: string): value is DetailMetricCardKey {
  return (ALL_DETAIL_METRIC_CARD_KEYS as readonly string[]).includes(value)
}

export function isHomeQuickControlKey(value: string): value is HomeQuickControlKey {
  return (ALL_HOME_QUICK_CONTROL_KEYS as readonly string[]).includes(value)
}

export function isNodeListMetadataField(value: string): value is NodeListMetadataField {
  return (ALL_NODE_LIST_METADATA_FIELDS as readonly string[]).includes(value)
}

export function isChartDashboardCardKey(value: string): value is ChartDashboardCardKey {
  return (ALL_CHART_DASHBOARD_CARDS as readonly string[]).includes(value)
}

export function parseGeneralCardPreset(value: unknown): GeneralCardPreset {
  if (typeof value !== 'string')
    return 'basic'

  return GENERAL_CARD_PRESET_ALIASES[value.trim()] ?? 'basic'
}

export function parseDetailMetricCardPreset(value: unknown): DetailMetricCardPreset {
  if (typeof value !== 'string')
    return 'finance'

  return DETAIL_METRIC_CARD_PRESET_ALIASES[value.trim()] ?? 'finance'
}

export function parseChartDashboardPreset(value: unknown): ChartDashboardPreset {
  if (typeof value !== 'string')
    return 'all'

  return CHART_DASHBOARD_PRESET_ALIASES[value.trim()] ?? 'all'
}

export function parseGeneralCardSlots(settings: ThemeSettings): GeneralCardKey[] {
  const keys: GeneralCardKey[] = []
  const seenKeys = new Set<GeneralCardKey>()

  for (let index = 1; index <= GENERAL_CARD_SLOT_COUNT; index += 1) {
    const value = settings[`generalCardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isGeneralCardKey(normalized)
      ? normalized
      : GENERAL_CARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseDetailMetricCardSlots(settings: ThemeSettings): DetailMetricCardKey[] {
  const keys: DetailMetricCardKey[] = []
  const seenKeys = new Set<DetailMetricCardKey>()

  for (let index = 1; index <= DETAIL_METRIC_CARD_SLOT_COUNT; index += 1) {
    const value = settings[`detailMetricCardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isDetailMetricCardKey(normalized)
      ? normalized
      : DETAIL_METRIC_CARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseChartDashboardSlots(settings: ThemeSettings): ChartDashboardCardKey[] {
  const keys: ChartDashboardCardKey[] = []
  const seenKeys = new Set<ChartDashboardCardKey>()

  for (let index = 1; index <= CHART_DASHBOARD_SLOT_COUNT; index += 1) {
    const value = settings[`chartDashboardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isChartDashboardCardKey(normalized)
      ? normalized
      : CHART_DASHBOARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseHomeQuickControlPreset(value: unknown): HomeQuickControlPreset {
  if (typeof value !== 'string')
    return 'full'

  return HOME_QUICK_CONTROL_PRESET_ALIASES[value.trim()] ?? 'full'
}

export function normalizeHomeQuickControlOrder(keys: HomeQuickControlKey[]): HomeQuickControlKey[] {
  return [...new Set(keys)]
}

export function parseKeyList<T extends string>(rawValue: unknown, isValid: (value: string) => value is T, fallback: readonly T[]): T[] {
  const parsedKeys: T[] = []
  const seenKeys = new Set<T>()

  const rawItems = Array.isArray(rawValue)
    ? rawValue
    : typeof rawValue === 'string'
      ? rawValue.split(KEY_LIST_SEPARATOR_REGEX)
      : []

  for (const item of rawItems) {
    const key = typeof item === 'string' ? item.trim() : ''
    if (!isValid(key) || seenKeys.has(key))
      continue
    parsedKeys.push(key)
    seenKeys.add(key)
  }

  return parsedKeys.length > 0 ? parsedKeys : [...fallback]
}

export function parseChartDashboardTemplate(rawValue: unknown): ChartDashboardTemplate {
  if (!rawValue)
    return { cards: [...DEFAULT_CHART_DASHBOARD_CARDS] }

  let value: unknown = rawValue
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return { cards: parseKeyList(value, isChartDashboardCardKey, DEFAULT_CHART_DASHBOARD_CARDS) }
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { cards: [...DEFAULT_CHART_DASHBOARD_CARDS] }

  const record = value as Record<string, unknown>
  return {
    cards: parseKeyList(record.cards ?? record.layout, isChartDashboardCardKey, DEFAULT_CHART_DASHBOARD_CARDS),
  }
}

export function readBooleanSetting(settings: ThemeSettings, key: string, fallback: boolean): boolean {
  const value = settings[key]
  return typeof value === 'boolean' ? value : fallback
}

export function readNumberSetting(settings: ThemeSettings, key: string, fallback: number, min: number, max: number): number {
  const value = settings[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    return fallback

  return Math.min(Math.max(value, min), max)
}

export function readStringSetting(settings: ThemeSettings, key: string, fallback = ''): string {
  const value = settings[key]
  return typeof value === 'string' ? value.trim() : fallback
}

export function readColorSetting(settings: ThemeSettings, key: string, fallback: string): string {
  const trimmed = readStringSetting(settings, key, fallback)
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed : fallback
}

export function readColorValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string')
    return fallback
  const trimmed = value.trim()
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed : fallback
}

export function parseGlassCustomColors(settings: ThemeSettings): GlassCustomColors {
  const legacyColors: GlassCustomColors = {
    lightCard: readColorSetting(settings, 'glassLightCardColor', DEFAULT_GLASS_CUSTOM_COLORS.lightCard),
    lightControl: readColorSetting(settings, 'glassLightControlColor', DEFAULT_GLASS_CUSTOM_COLORS.lightControl),
    lightText: readColorSetting(settings, 'glassLightTextColor', DEFAULT_GLASS_CUSTOM_COLORS.lightText),
    lightMutedText: readColorSetting(settings, 'glassLightMutedTextColor', DEFAULT_GLASS_CUSTOM_COLORS.lightMutedText),
    lightBorder: readColorSetting(settings, 'glassLightBorderColor', DEFAULT_GLASS_CUSTOM_COLORS.lightBorder),
    darkCard: readColorSetting(settings, 'glassDarkCardColor', DEFAULT_GLASS_CUSTOM_COLORS.darkCard),
    darkControl: readColorSetting(settings, 'glassDarkControlColor', DEFAULT_GLASS_CUSTOM_COLORS.darkControl),
    darkText: readColorSetting(settings, 'glassDarkTextColor', DEFAULT_GLASS_CUSTOM_COLORS.darkText),
    darkMutedText: readColorSetting(settings, 'glassDarkMutedTextColor', DEFAULT_GLASS_CUSTOM_COLORS.darkMutedText),
    darkBorder: readColorSetting(settings, 'glassDarkBorderColor', DEFAULT_GLASS_CUSTOM_COLORS.darkBorder),
  }

  let rawValue = settings.glassCustomColors
  if (typeof rawValue === 'string') {
    try {
      rawValue = JSON.parse(rawValue) as unknown
    }
    catch {
      return legacyColors
    }
  }

  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue))
    return legacyColors

  const record = rawValue as Record<keyof GlassCustomColors, unknown>
  return {
    lightCard: readColorValue(record.lightCard, legacyColors.lightCard),
    lightControl: readColorValue(record.lightControl, legacyColors.lightControl),
    lightText: readColorValue(record.lightText, legacyColors.lightText),
    lightMutedText: readColorValue(record.lightMutedText, legacyColors.lightMutedText),
    lightBorder: readColorValue(record.lightBorder, legacyColors.lightBorder),
    darkCard: readColorValue(record.darkCard, legacyColors.darkCard),
    darkControl: readColorValue(record.darkControl, legacyColors.darkControl),
    darkText: readColorValue(record.darkText, legacyColors.darkText),
    darkMutedText: readColorValue(record.darkMutedText, legacyColors.darkMutedText),
    darkBorder: readColorValue(record.darkBorder, legacyColors.darkBorder),
  }
}

export function parseGlassColorPreset(value: unknown): GlassColorPreset {
  if (typeof value !== 'string')
    return 'emerald'
  return GLASS_COLOR_PRESET_ALIASES[value.trim()] ?? 'emerald'
}

export function parseColorVisionMode(value: unknown): ColorVisionMode {
  if (typeof value !== 'string')
    return 'default'
  return COLOR_VISION_MODE_ALIASES[value.trim()] ?? 'default'
}
