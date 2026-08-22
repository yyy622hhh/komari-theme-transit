import { watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { normalizeThemeSettings } from '@/utils/themeSettings'
import { readThemeSettingsHistory, recordThemeSettingsVersion } from '@/utils/themeSettingsHistory'

/**
 * 挂到 App.vue 根组件一次，让配置版本历史的记录和"配置备份"面板有没有打开无关
 * ——不然操作者只有点开那个面板才会开始攒历史，等真出问题想回滚时才发现啥都
 * 没记下来。只对已登录管理员开启：访客的浏览器没有回滚这个功能可用，没理由替
 * 他们囤配置快照。
 */
export function useThemeSettingsHistoryRecorder(): void {
  const appStore = useAppStore()
  watch(
    () => appStore.publicSettings?.theme_settings,
    (raw) => {
      if (!appStore.privateFeaturesAllowed)
        return
      const settings = normalizeThemeSettings(raw)
      if (Object.keys(settings).length === 0)
        return
      const source = readThemeSettingsHistory().length > 0 ? 'external-change' : 'initial'
      recordThemeSettingsVersion(settings, source)
    },
    { immediate: true },
  )
}
