import type { ComputedRef } from 'vue'
import type { ThemeSettings } from '@/utils/themeSettings'
import { computed } from 'vue'
import { readBooleanSetting, readNumberSetting } from '@/stores/app.settings'
import { resolveThemeBackgroundSource } from '@/utils/themeSettings'

/**
 * 自定义背景相关设置，从 `stores/app.ts` 拆出来只是为了把它顶到 600 行的那部分
 * 挪走。`currentBackgroundUrl` 需要已解析好的当前主题模式，由调用方（`app.ts`）
 * 传入 `resolvedThemeMode`，避免这里重复解析一遍深浅色逻辑。
 */
export function createBackgroundSettings(
  themeSettings: ComputedRef<ThemeSettings>,
  resolvedThemeMode: ComputedRef<'light' | 'dark'>,
) {
  const backgroundEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'backgroundEnabled', false))

  const backgroundType = computed<'image' | 'video'>(() => {
    const settings = themeSettings.value
    if (typeof settings.backgroundType === 'string') {
      const type = settings.backgroundType
      if (type === 'image' || type === 'video') {
        return type
      }
    }
    return 'image'
  })

  const lightBackgroundUrl = computed<string>(() => resolveThemeBackgroundSource(themeSettings.value.lightBackgroundUrl))

  const darkBackgroundUrl = computed<string>(() => resolveThemeBackgroundSource(themeSettings.value.darkBackgroundUrl))

  const currentBackgroundUrl = computed<string>(() => {
    return resolvedThemeMode.value === 'dark' ? darkBackgroundUrl.value : lightBackgroundUrl.value
  })

  const backgroundBlur = computed<number>(() => readNumberSetting(themeSettings.value, 'backgroundBlur', 0, 0, Number.MAX_SAFE_INTEGER))

  const backgroundOverlay = computed<number>(() => readNumberSetting(themeSettings.value, 'backgroundOverlay', 0, -100, 100))

  return {
    backgroundEnabled,
    backgroundType,
    lightBackgroundUrl,
    darkBackgroundUrl,
    currentBackgroundUrl,
    backgroundBlur,
    backgroundOverlay,
  }
}
