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
  /**
   * 必须把 privateFeaturesAllowed 也放进被 watch 的源里，不能只在回调里判断——
   * 认证状态确认往往比 publicSettings 的首次拉取更晚完成。如果只 watch
   * theme_settings，两者哪个后到都可能让这次变化被回调里的权限判断吞掉，而
   * theme_settings 在下次真正改变前不会再触发 watch，历史就永久漏记这一份。
   */
  watch(
    () => [appStore.publicSettings?.theme_settings, appStore.privateFeaturesAllowed] as const,
    ([raw, allowed]) => {
      if (!allowed)
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
