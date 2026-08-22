import type { NodeCardSize } from '@/stores/app.types'
import type { VersionInfo } from '@/utils/api'
import type { SetupWizardPresetFields, SetupWizardPresetId } from '@/utils/setupWizardPresets'
import { computed, onScopeDispose, ref } from 'vue'
import { getCompanionRouteProbeHealth } from '@/services/route-probe-companion.service'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { loadServerVersion } from '@/services/version.service'
import { useAppStore } from '@/stores/app'
import {
  parseChartDashboardPreset,
  parseDetailMetricCardPreset,
  parseGeneralCardPreset,
  parseHomeQuickControlPreset,
  readBooleanSetting,
} from '@/stores/app.settings'
import { useNodesStore } from '@/stores/nodes'
import { message } from '@/utils/message'
import { getSetupWizardPreset, SETUP_WIZARD_PRESETS } from '@/utils/setupWizardPresets'
import { normalizeThemeSettings } from '@/utils/themeSettings'
import { diffThemeSettings } from '@/utils/themeSettingsBackup'
import { recordThemeSettingsVersion } from '@/utils/themeSettingsHistory'

export type SetupWizardStep = 'welcome' | 'preset' | 'advanced' | 'detect' | 'confirm'

const DISMISSED_KEY = 'transit:setup-wizard-dismissed'

function isValidNodeCardSize(value: unknown): value is NodeCardSize {
  return value === 'mini' || value === 'compact' || value === 'comfortable' || value === 'large'
}

export function hasSeenSetupWizard(): boolean {
  if (typeof localStorage === 'undefined')
    return true
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  }
  catch {
    return true
  }
}

function markSetupWizardSeen(): void {
  if (typeof localStorage === 'undefined')
    return
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  }
  catch {
  }
}

/** 从当前主题配置里，把向导关心的这一小撮字段读出来，作为"自定义"起点。 */
function readCurrentPresetFields(raw: unknown): SetupWizardPresetFields {
  const settings = normalizeThemeSettings(raw)
  const cardSize = settings.nodeCardSize
  return {
    nodeCardSize: isValidNodeCardSize(cardSize) ? cardSize : 'compact',
    generalCardPreset: parseGeneralCardPreset(settings.generalCardPreset),
    homeQuickControlPreset: parseHomeQuickControlPreset(settings.homeQuickControlPreset),
    detailMetricCardPreset: parseDetailMetricCardPreset(settings.detailMetricCardPreset),
    chartDashboardPreset: parseChartDashboardPreset(settings.chartDashboardPreset),
    topologyEnabled: readBooleanSetting(settings, 'topologyEnabled', true),
    diskPredictionEnabled: readBooleanSetting(settings, 'diskPredictionEnabled', false),
    gpuChartEnabled: readBooleanSetting(settings, 'gpuChartEnabled', false),
    opsDashboardEnabled: readBooleanSetting(settings, 'opsDashboardEnabled', true),
    nodeListMetadataEnabled: readBooleanSetting(settings, 'nodeListMetadataEnabled', true),
    disablePageAnimation: readBooleanSetting(settings, 'disablePageAnimation', false),
    hideAdminEntryWhenLoggedOut: readBooleanSetting(settings, 'hideAdminEntryWhenLoggedOut', false),
    hidePriceWhenLoggedOut: readBooleanSetting(settings, 'hidePriceWhenLoggedOut', false),
  }
}

/**
 * Transit 设置中心向导：欢迎 → 选预设（简洁/日常/专业/自定义）→（仅自定义）
 * 展开高级字段 → 自动检测 → 确认应用。只覆盖 `setupWizardPresets.ts` 里那一小
 * 撮字段，不是完整的 58 项配置编辑器——那些仍然只能在 Komari 后台改。
 */
export function useSetupWizard() {
  const appStore = useAppStore()
  const nodesStore = useNodesStore()

  const step = ref<SetupWizardStep>('welcome')
  const selection = ref<SetupWizardPresetId | 'custom'>('daily')
  const customFields = ref<SetupWizardPresetFields>(getSetupWizardPreset('daily').fields)

  const detecting = ref(false)
  const serverVersion = ref<VersionInfo | null>(null)
  const companionAvailable = ref<boolean | null>(null)
  const enableRouteProbe = ref(false)

  const applying = ref(false)
  const applyError = ref<string | null>(null)

  let detectGeneration = 0
  let detectController: AbortController | null = null

  onScopeDispose(() => {
    detectGeneration += 1
    detectController?.abort()
  })

  const fields = computed<SetupWizardPresetFields>(() => selection.value === 'custom' ? customFields.value : getSetupWizardPreset(selection.value).fields)

  const patch = computed<Record<string, unknown>>(() => ({
    ...fields.value,
    ...(enableRouteProbe.value ? { routeProbeEnabled: true } : {}),
  }))

  const currentSettings = computed(() => normalizeThemeSettings(appStore.publicSettings?.theme_settings))
  const diff = computed(() => diffThemeSettings(currentSettings.value, { ...currentSettings.value, ...patch.value }))

  function selectPreset(id: SetupWizardPresetId | 'custom'): void {
    selection.value = id
    if (id === 'custom')
      customFields.value = readCurrentPresetFields(appStore.publicSettings?.theme_settings)
  }

  function updateCustomField<K extends keyof SetupWizardPresetFields>(key: K, value: SetupWizardPresetFields[K]): void {
    customFields.value = { ...customFields.value, [key]: value }
  }

  function goToPreset(): void {
    step.value = 'preset'
  }

  function goToAdvanced(): void {
    step.value = 'advanced'
  }

  async function goToDetect(): Promise<void> {
    detectController?.abort()
    const generation = ++detectGeneration
    const controller = new AbortController()
    detectController = controller
    const timeoutId = setTimeout(() => controller.abort(), 8_000)
    step.value = 'detect'
    detecting.value = true
    try {
      const [version, companion] = await Promise.all([
        loadServerVersion(),
        getCompanionRouteProbeHealth(controller.signal).then(health => health.ok).catch(() => false),
      ])
      if (generation !== detectGeneration)
        return
      serverVersion.value = version
      companionAvailable.value = companion
    }
    finally {
      clearTimeout(timeoutId)
      if (generation === detectGeneration)
        detecting.value = false
    }
  }

  /** 选了现成预设就跳过自定义字段页，直接进检测；选了自定义就先展开高级字段。 */
  async function goToAdvancedOrDetect(): Promise<void> {
    if (selection.value === 'custom')
      goToAdvanced()
    else
      await goToDetect()
  }

  function goToConfirm(): void {
    step.value = 'confirm'
  }

  function back(): void {
    if (step.value === 'confirm')
      step.value = 'detect'
    else if (step.value === 'detect')
      step.value = selection.value === 'custom' ? 'advanced' : 'preset'
    else if (step.value === 'advanced')
      step.value = 'preset'
    else if (step.value === 'preset')
      step.value = 'welcome'
  }

  async function apply(): Promise<boolean> {
    const publicSettings = appStore.publicSettings
    if (!publicSettings)
      return false
    applying.value = true
    applyError.value = null
    try {
      const saved = await saveManagedThemeSettings({
        theme: publicSettings.theme,
        patch: patch.value,
        permission: 'configBackup',
        requestKey: `setup-wizard:apply:${publicSettings.theme}`,
        onPublicSettings: appStore.applyPublicSettings,
      })
      if (!recordThemeSettingsVersion(saved, 'theme-write'))
        message.warning('设置已应用，但本机历史记录写入失败，回滚列表可能不是最新。')
      else
        message.success('设置已应用。')
      markSetupWizardSeen()
      return true
    }
    catch (error) {
      applyError.value = error instanceof Error ? error.message : '应用失败。'
      return false
    }
    finally {
      applying.value = false
    }
  }

  function dismiss(): void {
    markSetupWizardSeen()
  }

  function reset(): void {
    step.value = 'welcome'
    selection.value = 'daily'
    customFields.value = getSetupWizardPreset('daily').fields
    serverVersion.value = null
    companionAvailable.value = null
    enableRouteProbe.value = false
    applyError.value = null
  }

  return {
    presets: SETUP_WIZARD_PRESETS,
    step,
    selection,
    customFields,
    fields,
    diff,
    detecting,
    serverVersion,
    companionAvailable,
    enableRouteProbe,
    applying,
    applyError,
    nodesStore,
    selectPreset,
    updateCustomField,
    goToPreset,
    goToAdvancedOrDetect,
    goToDetect,
    goToConfirm,
    back,
    apply,
    dismiss,
    reset,
  }
}
