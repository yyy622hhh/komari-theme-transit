export type ThemeSettings = Record<string, unknown>

// These are defensive browser-memory limits, not product-level configuration
// limits. Keep them comfortably above Komari's practical request/database
// limits so existing topology data and future theme fields remain compatible.
const MAX_THEME_SETTINGS_BYTES = 16 * 1024 * 1024
const MAX_THEME_SETTINGS_DEPTH = 64
const MAX_THEME_SETTINGS_ENTRIES = 100_000
const MAX_THEME_SETTING_STRING_LENGTH = 8 * 1024 * 1024
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const INVALID_VALUE = Symbol('invalid-theme-setting')

interface ValidationState {
  entries: number
  seen: Set<object>
  strict: boolean
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function containsUrlControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function invalid(state: ValidationState, message: string): typeof INVALID_VALUE {
  if (state.strict)
    throw new Error(message)
  return INVALID_VALUE
}

function sanitizeJsonValue(value: unknown, depth: number, state: ValidationState): unknown | typeof INVALID_VALUE {
  if (value === null || typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : invalid(state, '主题配置包含无效数字。')
  if (typeof value === 'string')
    return value.length <= MAX_THEME_SETTING_STRING_LENGTH ? value : invalid(state, '主题配置字符串过长。')
  if (depth >= MAX_THEME_SETTINGS_DEPTH)
    return invalid(state, '主题配置嵌套层级过深。')
  if (!Array.isArray(value) && !isPlainRecord(value))
    return invalid(state, '主题配置只能包含 JSON 数据。')
  if (state.seen.has(value))
    return invalid(state, '主题配置不能包含循环引用。')

  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const item of value) {
        state.entries += 1
        if (state.entries > MAX_THEME_SETTINGS_ENTRIES)
          return invalid(state, '主题配置项目过多。')
        const sanitized = sanitizeJsonValue(item, depth + 1, state)
        if (sanitized === INVALID_VALUE)
          return INVALID_VALUE
        result.push(sanitized)
      }
      return result
    }

    const result = Object.create(null) as ThemeSettings
    for (const [key, item] of Object.entries(value)) {
      state.entries += 1
      if (state.entries > MAX_THEME_SETTINGS_ENTRIES)
        return invalid(state, '主题配置项目过多。')
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        if (state.strict)
          throw new Error('主题配置包含不安全的对象键。')
        continue
      }
      const sanitized = sanitizeJsonValue(item, depth + 1, state)
      if (sanitized !== INVALID_VALUE)
        result[key] = sanitized
    }
    return result
  }
  finally {
    state.seen.delete(value)
  }
}

function sanitizeRoot(value: unknown, strict: boolean): ThemeSettings {
  if (!isPlainRecord(value)) {
    if (strict)
      throw new Error('主题配置必须是 JSON 对象。')
    return {}
  }

  const sanitized = sanitizeJsonValue(value, 0, {
    entries: 0,
    seen: new Set<object>(),
    strict,
  })
  if (sanitized === INVALID_VALUE || !isPlainRecord(sanitized))
    return {}

  const serialized = JSON.stringify(sanitized)
  if (byteLength(serialized) > MAX_THEME_SETTINGS_BYTES) {
    if (strict)
      throw new Error('主题配置超过浏览器安全大小限制。')
    return {}
  }
  return sanitized
}

/** Normalize untrusted public settings without breaking unknown future keys. */
export function normalizeThemeSettings(raw: unknown): ThemeSettings {
  if (!raw)
    return {}

  let value: unknown = raw
  if (typeof value === 'string') {
    if (byteLength(value) > MAX_THEME_SETTINGS_BYTES)
      return {}
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return {}
    }
  }
  return sanitizeRoot(value, false)
}

/** Validate locally generated settings before sending them to an admin endpoint. */
export function validateThemeSettings(raw: unknown): ThemeSettings {
  return sanitizeRoot(raw, true)
}

/** Parse the complete server value for a replace-style mutation without loss. */
export function validateServerThemeSettings(raw: unknown): ThemeSettings {
  let value: unknown = raw
  if (typeof value === 'string') {
    if (byteLength(value) > MAX_THEME_SETTINGS_BYTES)
      throw new Error('服务器主题配置超过浏览器安全大小，请先在官方后台检查配置。')
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      throw new Error('服务器主题配置不是有效 JSON，请先在官方后台修复。')
    }
  }
  return validateThemeSettings(value ?? {})
}

export function resolveThemeBackgroundSource(value: unknown): string {
  if (typeof value !== 'string')
    return ''

  const source = value.trim()
  if (!source)
    return ''
  if (containsUrlControlCharacter(source))
    return ''
  if (source.toLowerCase().startsWith('local:')) {
    const segments = source.slice('local:'.length)
      .replaceAll('\\', '/')
      .split('/')
      .filter(Boolean)
    if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..'))
      return ''
    return `/themes/user-assets/${segments.map(segment => encodeURIComponent(segment)).join('/')}`
  }
  if (source.startsWith('/') && !source.startsWith('//') && !source.includes('\\'))
    return source

  try {
    const url = new URL(source)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  }
  catch {
    return ''
  }
}
