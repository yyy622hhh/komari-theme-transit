import type { ThemeSettings } from '@/utils/themeSettings'
import type { ThemeSettingsDiffEntry } from '@/utils/themeSettingsBackup'
import type { ThemeSettingsVersionEntry } from '@/utils/themeSettingsHistory'
import { computed, onScopeDispose, ref } from 'vue'
import { downloadText } from '@/services/snapshot.service'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { useAppStore } from '@/stores/app'
import { message } from '@/utils/message'
import { normalizeThemeSettings } from '@/utils/themeSettings'
import { buildThemeSettingsExport, diffThemeSettings, parseThemeSettingsImport, themeSettingsEqual } from '@/utils/themeSettingsBackup'
import { clearThemeSettingsHistory, readThemeSettingsHistory, recordThemeSettingsVersion } from '@/utils/themeSettingsHistory'

function exportFilenameStamp(at: number): string {
  const iso = new Date(at).toISOString()
  return iso.slice(0, 16).replace(/[:T]/g, '-')
}

/**
 * 配置备份/导出/导入/回滚面板的状态与操作。版本历史的自动记录不在这里——那部分
 * 由 `useThemeSettingsHistoryRecorder`（挂在 App.vue 根组件）负责，这样不管操作
 * 者有没有打开这个面板都会持续记录；这里只负责读取、导出、导入预览和回滚执行。
 */
export function useThemeSettingsBackup() {
  const appStore = useAppStore()
  const importing = ref(false)
  const readingImport = ref(false)
  const exporting = ref(false)
  const rollingBackAt = ref<number | null>(null)
  const history = ref<ThemeSettingsVersionEntry[]>(readThemeSettingsHistory())
  const importPreview = ref<{ settings: ThemeSettings, diff: ThemeSettingsDiffEntry[], themeVersion: string | null } | null>(null)
  const importError = ref<string | null>(null)
  const rollbackPreview = ref<{ entry: ThemeSettingsVersionEntry, diff: ThemeSettingsDiffEntry[] } | null>(null)
  const writing = computed(() => importing.value || rollingBackAt.value !== null)
  let importGeneration = 0
  let disposed = false
  onScopeDispose(() => {
    disposed = true
    cancelImport()
  })

  function refreshHistory(): void {
    history.value = readThemeSettingsHistory()
  }

  function currentSettings(): ThemeSettings {
    return normalizeThemeSettings(appStore.publicSettings?.theme_settings)
  }

  const liveSettings = computed(() => currentSettings())

  function isCurrentEntry(entry: ThemeSettingsVersionEntry): boolean {
    return themeSettingsEqual(entry.settings, liveSettings.value)
  }

  function noteHistoryWrite(ok: boolean): void {
    if (!ok)
      message.warning('配置已保存，但本机历史记录写入失败，回滚列表可能不是最新。')
  }

  function exportSettings(): void {
    exporting.value = true
    try {
      const file = buildThemeSettingsExport(currentSettings(), __BUILD_VERSION__)
      downloadText(`transit-config-${exportFilenameStamp(file.exportedAt)}.json`, JSON.stringify(file, null, 2), 'application/json')
      message.success('配置已导出。')
    }
    finally {
      exporting.value = false
    }
  }

  async function stageImportFile(file: File): Promise<void> {
    if (disposed || writing.value)
      return
    cancelRollback()
    cancelImport()
    const generation = importGeneration
    readingImport.value = true
    try {
      const text = await file.text()
      if (generation !== importGeneration)
        return
      const result = parseThemeSettingsImport(JSON.parse(text))
      if (!result.ok) {
        importError.value = result.error
        return
      }
      importPreview.value = {
        settings: result.settings,
        diff: diffThemeSettings(currentSettings(), result.settings),
        themeVersion: result.themeVersion,
      }
    }
    catch {
      if (generation === importGeneration)
        importError.value = '文件读取失败或不是合法的 JSON。'
    }
    finally {
      if (generation === importGeneration)
        readingImport.value = false
    }
  }

  function cancelImport(): void {
    importGeneration++
    readingImport.value = false
    importPreview.value = null
    importError.value = null
  }

  async function confirmImport(): Promise<void> {
    const preview = importPreview.value
    const publicSettings = appStore.publicSettings
    if (disposed || writing.value || readingImport.value || importError.value || !preview || !publicSettings)
      return
    importing.value = true
    try {
      const saved = await saveManagedThemeSettings({
        theme: publicSettings.theme,
        patch: preview.settings,
        permission: 'configBackup',
        requestKey: `config-backup:import:${publicSettings.theme}`,
        strategy: 'replace',
        onPublicSettings: appStore.applyPublicSettings,
      })
      noteHistoryWrite(recordThemeSettingsVersion(saved, 'import'))
      refreshHistory()
      message.success('配置已导入并保存。')
      importPreview.value = null
      rollbackPreview.value = null
    }
    catch (error) {
      message.error(error instanceof Error ? error.message : '导入失败。')
    }
    finally {
      importing.value = false
    }
  }

  function stageRollback(entry: ThemeSettingsVersionEntry): void {
    if (disposed || writing.value)
      return
    cancelImport()
    rollbackPreview.value = { entry, diff: diffThemeSettings(currentSettings(), entry.settings) }
  }

  function cancelRollback(): void {
    rollbackPreview.value = null
  }

  async function confirmRollback(): Promise<void> {
    const preview = rollbackPreview.value
    const publicSettings = appStore.publicSettings
    if (disposed || writing.value || !preview || !publicSettings)
      return
    rollingBackAt.value = preview.entry.at
    try {
      const saved = await saveManagedThemeSettings({
        theme: publicSettings.theme,
        patch: preview.entry.settings,
        permission: 'configBackup',
        requestKey: `config-backup:rollback:${publicSettings.theme}`,
        strategy: 'replace',
        onPublicSettings: appStore.applyPublicSettings,
      })
      noteHistoryWrite(recordThemeSettingsVersion(saved, 'rollback'))
      refreshHistory()
      message.success('已回滚到所选版本。')
      rollbackPreview.value = null
      importPreview.value = null
    }
    catch (error) {
      message.error(error instanceof Error ? error.message : '回滚失败。')
    }
    finally {
      rollingBackAt.value = null
    }
  }

  function clearHistory(): void {
    clearThemeSettingsHistory()
    refreshHistory()
  }

  return {
    history,
    isCurrentEntry,
    importing,
    readingImport,
    writing,
    exporting,
    rollingBackAt,
    importPreview,
    importError,
    rollbackPreview,
    exportSettings,
    stageImportFile,
    cancelImport,
    confirmImport,
    stageRollback,
    cancelRollback,
    confirmRollback,
    clearHistory,
  }
}
