import type { ComputedRef, Ref } from 'vue'
import type { ManagedThemeMode, ThemeMode } from './app.types'
import type { ThemeSettings } from '@/utils/themeSettings'
import { computed } from 'vue'
import { getBeijingHour, isValidManagedThemeMode, isValidThemeMode } from '@/stores/app.settings'

/**
 * 深色/浅色模式解析，从 `stores/app.ts` 拆出来只是为了把它顶到 600 行的那部分
 * 挪走——逻辑本身没有变化。本机按钮选择 auto 时跟随后台托管设置；手动选择浅色/
 * 深色时仅覆盖当前浏览器。
 */
export function createThemeModeState(
  themeSettings: ComputedRef<ThemeSettings>,
  themeMode: Ref<ThemeMode>,
  minuteTick: Ref<Date>,
) {
  const managedThemeMode = computed<ManagedThemeMode>(() => {
    const value = themeSettings.value.themeMode
    return isValidManagedThemeMode(value) ? value : 'beijing'
  })

  const isBeijingDaytime = computed<boolean>(() => {
    const hour = getBeijingHour(minuteTick.value.getTime())
    return hour >= 7 && hour < 19
  })

  const isDark = computed(() => {
    const localMode = isValidThemeMode(themeMode.value) ? themeMode.value : 'auto'
    if (localMode === 'light')
      return false
    if (localMode === 'dark')
      return true

    if (managedThemeMode.value === 'beijing')
      return !isBeijingDaytime.value

    return managedThemeMode.value === 'dark'
  })

  const resolvedThemeMode = computed<'light' | 'dark'>(() => isDark.value ? 'dark' : 'light')

  return { managedThemeMode, isBeijingDaytime, isDark, resolvedThemeMode }
}
