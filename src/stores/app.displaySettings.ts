import type { ComputedRef, Ref } from 'vue'
import type {
  ChartDashboardTemplate,
  ColorVisionMode,
  DetailMetricCardKey,
  EarthRenderer,
  GeneralCardKey,
  GlassColorPreset,
  GlassCustomColors,
  HomeQuickControlKey,
  NodeListMetadataField,
} from './app.types'
import type { ThemeSettings } from '@/utils/themeSettings'
import { computed } from 'vue'
import { isNodeCardPanelDefaultMode, parseNodeCardPanelConfigs } from '@/utils/nodeCardPanel'
import { parseNodeControls } from '@/utils/nodeControl'
import {
  ALL_GENERAL_CARD_KEYS,
  CHART_DASHBOARD_PRESETS,
  DEFAULT_CHART_DASHBOARD_CARDS,
  DEFAULT_DETAIL_METRIC_CARD_ORDER,
  DEFAULT_GENERAL_CARD_ENABLED,
  DEFAULT_GENERAL_CARD_ORDER,
  DEFAULT_HOME_QUICK_CONTROL_ORDER,
  DEFAULT_NODE_LIST_METADATA_FIELDS,
  DETAIL_METRIC_CARD_PRESETS,
  GENERAL_CARD_PRESETS,
  HOME_QUICK_CONTROL_PRESETS,
  isDetailMetricCardKey,
  isGeneralCardKey,
  isHomeQuickControlKey,
  isNodeListMetadataField,
  LEGACY_GENERAL_CARD_SETTING_KEYS,
  normalizeHomeQuickControlOrder,
  parseChartDashboardPreset,
  parseChartDashboardSlots,
  parseChartDashboardTemplate,
  parseColorVisionMode,
  parseDetailMetricCardPreset,
  parseDetailMetricCardSlots,
  parseGeneralCardPreset,
  parseGeneralCardSlots,
  parseGlassColorPreset,
  parseGlassCustomColors,
  parseHomeQuickControlPreset,
  parseKeyList,
  readBooleanSetting,
  readNumberSetting,
  readStringSetting,
} from './app.settings'

function isValidEarthRenderer(value: unknown): value is EarthRenderer {
  return value === 'realistic' || value === 'cobe' || value === 'tiled'
}

/**
 * 首页布局、节点卡片/列表展示、详情卡片与图表面板等托管设置的读取，占了
 * `stores/app.ts` 里最大的一块（近 40 个字段），全部只依赖 `themeSettings`
 * 这一份响应式数据源，因此整块搬到这里不改变任何对外形状——`app.ts` 原样
 * 解构并继续导出同名字段。
 */
export function createDisplaySettings(themeSettings: ComputedRef<ThemeSettings>, minuteTick: Ref<Date>) {
  const alertEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'alertEnabled', false))

  const alertTitle = computed<string>(() => {
    const value = themeSettings.value.alertTitle
    return typeof value === 'string' ? value : ''
  })

  const alertContent = computed<string>(() => {
    const value = themeSettings.value.alertContent
    return typeof value === 'string' ? value : ''
  })

  const dataUpdateInterval = computed<number>(() => readNumberSetting(themeSettings.value, 'dataUpdateInterval', 3, 1, 60))

  const stopEarth = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'stopEarth', false))

  const earthRenderer = computed<EarthRenderer>(() => {
    const value = themeSettings.value.earthRenderer
    return isValidEarthRenderer(value) ? value : 'realistic'
  })

  const hideEarth = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'hideEarth', false))

  const hideGeneralCard = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'hideGeneralCard', false))

  const visitorInfoEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'visitorInfoEnabled', false))

  const visitorAuditClientEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'visitorAuditClientEnabled', false))

  const opsDashboardEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'opsDashboardEnabled', true))

  const nodeControls = computed(() => parseNodeControls(
    themeSettings.value.pandaOpsNodeControls,
    minuteTick.value.getTime(),
  ))

  const nodeCardPanelDefault = computed(() => {
    const value = themeSettings.value.nodeCardPanelDefault
    return isNodeCardPanelDefaultMode(value) ? value : 'carrier'
  })

  const nodeCardPanels = computed(() => parseNodeCardPanelConfigs(themeSettings.value.nodeCardPanels))

  const carrierPingRegion = computed<string>(() => {
    const value = readStringSetting(themeSettings.value, 'carrierPingRegion')
    return ['all', 'beijing', 'shanghai', 'guangdong'].includes(value) ? value : 'beijing'
  })

  const generalCardEnabledMap = computed<Record<GeneralCardKey, boolean>>(() => {
    const settings = themeSettings.value
    const enabledMap = { ...DEFAULT_GENERAL_CARD_ENABLED }

    for (const key of ALL_GENERAL_CARD_KEYS) {
      const settingKey = LEGACY_GENERAL_CARD_SETTING_KEYS[key]
      if (!settingKey)
        continue

      const value = settings[settingKey]
      if (typeof value === 'boolean')
        enabledMap[key] = value
    }

    return enabledMap
  })

  const generalCardOrder = computed<GeneralCardKey[]>(() => {
    const settings = themeSettings.value
    const hasNewPreset = typeof settings.generalCardPreset === 'string'
    const preset = parseGeneralCardPreset(settings.generalCardPreset)

    if (hasNewPreset) {
      if (preset === 'custom') {
        const advancedKeys = typeof settings.generalCardKeys === 'string'
          ? settings.generalCardKeys.trim()
          : ''
        if (advancedKeys)
          return parseKeyList(advancedKeys, isGeneralCardKey, DEFAULT_GENERAL_CARD_ORDER)

        const slotKeys = parseGeneralCardSlots(settings)
        return slotKeys.length > 0 ? slotKeys : [...DEFAULT_GENERAL_CARD_ORDER]
      }

      return [...GENERAL_CARD_PRESETS[preset]]
    }

    if (typeof settings.generalCardKeys === 'string')
      return parseKeyList(settings.generalCardKeys, isGeneralCardKey, DEFAULT_GENERAL_CARD_ORDER)

    const orderedKeys = parseKeyList(settings.generalCardOrder, isGeneralCardKey, DEFAULT_GENERAL_CARD_ORDER)
    const orderedKeySet = new Set<GeneralCardKey>(orderedKeys)
    for (const key of ALL_GENERAL_CARD_KEYS) {
      if (orderedKeySet.has(key))
        continue
      orderedKeys.push(key)
      orderedKeySet.add(key)
    }

    return orderedKeys.filter(key => generalCardEnabledMap.value[key])
  })

  const homeToolsEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'homeToolsEnabled', true))

  const glassColorPreset = computed<GlassColorPreset>(() => parseGlassColorPreset(themeSettings.value.glassColorPreset))

  const glassCustomColors = computed<GlassCustomColors>(() => parseGlassCustomColors(themeSettings.value))

  const colorVisionMode = computed<ColorVisionMode>(() => parseColorVisionMode(themeSettings.value.colorVisionMode))

  const colorVisionFriendly = computed<boolean>(() => colorVisionMode.value === 'accessible')

  const homeQuickControlsEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'homeQuickControlsEnabled', true))

  const homeQuickControlOrder = computed<HomeQuickControlKey[]>(() => {
    const settings = themeSettings.value
    const preset = parseHomeQuickControlPreset(settings.homeQuickControlPreset)
    if (preset === 'custom') {
      return normalizeHomeQuickControlOrder(
        parseKeyList(settings.homeQuickControlKeys, isHomeQuickControlKey, DEFAULT_HOME_QUICK_CONTROL_ORDER),
      )
    }

    if (typeof settings.homeQuickControlKeys === 'string' && typeof settings.homeQuickControlPreset !== 'string') {
      return normalizeHomeQuickControlOrder(
        parseKeyList(settings.homeQuickControlKeys, isHomeQuickControlKey, DEFAULT_HOME_QUICK_CONTROL_ORDER),
      )
    }

    return normalizeHomeQuickControlOrder([...HOME_QUICK_CONTROL_PRESETS[preset]])
  })

  const nodeListMetadataEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'nodeListMetadataEnabled', true))

  const nodeListMetadataFields = computed<NodeListMetadataField[]>(() => {
    return parseKeyList(themeSettings.value.nodeListMetadataFields, isNodeListMetadataField, DEFAULT_NODE_LIST_METADATA_FIELDS)
  })

  const nodeListCustomTagsVisible = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'nodeListCustomTagsVisible', true))

  const nodeDetailSectionTabsEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'nodeDetailSectionTabsEnabled', false))

  const gpuChartEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'gpuChartEnabled', false))

  const detailMetricCardOrder = computed<DetailMetricCardKey[]>(() => {
    const settings = themeSettings.value
    const preset = parseDetailMetricCardPreset(settings.detailMetricCardPreset)
    if (preset !== 'custom')
      return [...DETAIL_METRIC_CARD_PRESETS[preset]]

    const advancedKeys = typeof settings.detailMetricCardKeys === 'string'
      ? settings.detailMetricCardKeys.trim()
      : ''
    if (advancedKeys)
      return parseKeyList(advancedKeys, isDetailMetricCardKey, DEFAULT_DETAIL_METRIC_CARD_ORDER)

    const slotKeys = parseDetailMetricCardSlots(settings)
    return slotKeys.length > 0 ? slotKeys : [...DEFAULT_DETAIL_METRIC_CARD_ORDER]
  })

  const offlineNodesLast = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'offlineNodesLast', false))

  const homeHighLoadThreshold = computed<number>(() => readNumberSetting(themeSettings.value, 'homeHighLoadThreshold', 80, 1, 100))

  const homeTrafficWarningThreshold = computed<number>(() => readNumberSetting(themeSettings.value, 'homeTrafficWarningThreshold', 80, 1, 100))

  const homeExpiringDays = computed<number>(() => readNumberSetting(themeSettings.value, 'homeExpiringDays', 30, 1, 3650))

  const diskPredictionEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'diskPredictionEnabled', false))

  const diskPredictionThresholdDays = computed<number>(() => readNumberSetting(themeSettings.value, 'diskPredictionThresholdDays', 30, 1, 3650))

  const chartDashboardTemplate = computed<ChartDashboardTemplate>(() => {
    const settings = themeSettings.value

    // 旧配置没有 preset 字段时继续以原 JSON/key 列表为准。
    if (typeof settings.chartDashboardPreset !== 'string')
      return parseChartDashboardTemplate(settings.chartDashboardTemplate)

    const preset = parseChartDashboardPreset(settings.chartDashboardPreset)
    if (preset === 'advanced')
      return parseChartDashboardTemplate(settings.chartDashboardTemplate)

    if (preset === 'custom') {
      // 旧版托管设置使用 7 个独立卡位，升级后优先保留原有顺序。
      const slotKeys = parseChartDashboardSlots(settings)
      if (slotKeys.length > 0)
        return { cards: slotKeys }

      const customKeys = typeof settings.chartDashboardTemplate === 'string'
        ? settings.chartDashboardTemplate.trim()
        : ''
      if (customKeys)
        return parseChartDashboardTemplate(customKeys)

      return { cards: [...DEFAULT_CHART_DASHBOARD_CARDS] }
    }

    return { cards: [...CHART_DASHBOARD_PRESETS[preset]] }
  })

  const hideAdminEntryWhenLoggedOut = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'hideAdminEntryWhenLoggedOut', false))

  const hidePriceWhenLoggedOut = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'hidePriceWhenLoggedOut', false))

  const providerAliases = computed<string>(() => readStringSetting(themeSettings.value, 'providerAliases'))

  const disablePageAnimation = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'disablePageAnimation', false))

  return {
    alertEnabled,
    alertTitle,
    alertContent,
    dataUpdateInterval,
    stopEarth,
    earthRenderer,
    hideEarth,
    hideGeneralCard,
    visitorInfoEnabled,
    visitorAuditClientEnabled,
    opsDashboardEnabled,
    nodeControls,
    nodeCardPanelDefault,
    nodeCardPanels,
    carrierPingRegion,
    generalCardEnabledMap,
    generalCardOrder,
    homeToolsEnabled,
    glassColorPreset,
    glassCustomColors,
    colorVisionMode,
    colorVisionFriendly,
    homeQuickControlsEnabled,
    homeQuickControlOrder,
    nodeListMetadataEnabled,
    nodeListMetadataFields,
    nodeListCustomTagsVisible,
    nodeDetailSectionTabsEnabled,
    gpuChartEnabled,
    detailMetricCardOrder,
    offlineNodesLast,
    homeHighLoadThreshold,
    homeTrafficWarningThreshold,
    homeExpiringDays,
    diskPredictionEnabled,
    diskPredictionThresholdDays,
    chartDashboardTemplate,
    hideAdminEntryWhenLoggedOut,
    hidePriceWhenLoggedOut,
    providerAliases,
    disablePageAnimation,
  }
}
