import type {
  ChartDashboardTemplate,
  ColorVisionMode,
  DetailMetricCardKey,
  EarthRenderer,
  GeneralCardKey,
  GlassColorPreset,
  GlassCustomColors,
  HomeQuickControlKey,
  Lang,
  ManagedThemeMode,
  NodeCardSize,
  NodeListMetadataField,
  NodeViewMode,
  RpcTransportMode,
  ThemeMode,
} from './app.types'
import type { PermissionKey, VerifyLoginOptions } from '@/services/auth.service'
import type { MeInfo, PublicSettings } from '@/utils/api'
import type { ByteDecimalsConfig } from '@/utils/helper'
import { useNow, useStorageAsync } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { getAuthSession, requirePermission, setAuthSessionFromLogin, subscribeAuthSession, verifyLogin } from '@/services/auth.service'
import { isNodeCardPanelDefaultMode, parseNodeCardPanelConfigs } from '@/utils/nodeCardPanel'
import { parseNodeControls } from '@/utils/nodeControl'
import { normalizeThemeSettings, resolveThemeBackgroundSource } from '@/utils/themeSettings'
import {
  ALL_GENERAL_CARD_KEYS,
  BYTE_DECIMALS,
  CHART_DASHBOARD_PRESETS,
  DEFAULT_CHART_DASHBOARD_CARDS,
  DEFAULT_DETAIL_METRIC_CARD_ORDER,
  DEFAULT_GENERAL_CARD_ENABLED,
  DEFAULT_GENERAL_CARD_ORDER,
  DEFAULT_HOME_QUICK_CONTROL_ORDER,
  DEFAULT_NODE_LIST_METADATA_FIELDS,
  DETAIL_METRIC_CARD_PRESETS,
  GENERAL_CARD_PRESETS,
  getBeijingHour,
  HOME_QUICK_CONTROL_PRESETS,
  isDetailMetricCardKey,
  isGeneralCardKey,
  isHomeQuickControlKey,
  isNodeListMetadataField,
  isValidManagedThemeMode,
  isValidThemeMode,
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

const useAppStore = defineStore('app', () => {
  const loading = ref<boolean>(true)

  // 使用 VueUse 的 useStorageAsync 实现自动持久化
  const themeMode = useStorageAsync<ThemeMode>('themeMode', 'auto', localStorage)
  const lang = ref<Lang>('zh-CN')
  const publicSettings = ref<PublicSettings>()
  const nodeSelectedGroup = useStorageAsync<string>('nodeSelectedGroup', 'all', localStorage)
  const favoriteNodeIds = useStorageAsync<string[]>('theme:favorite-nodes:v1', [], localStorage)
  const isLoggedIn = ref<boolean>(getAuthSession().authenticated)
  const authStatus = ref(getAuthSession().status)
  const privateFeaturesAllowed = computed(() => authStatus.value === 'authenticated')
  const unsubscribeAuthSession = subscribeAuthSession((session) => {
    isLoggedIn.value = session.authenticated
    authStatus.value = session.status
  })
  onScopeDispose(unsubscribeAuthSession)
  const connectionError = ref<boolean>(false)
  const homeAdvancedToolsVisible = ref(false)
  const favoriteNodeIdSet = computed(() => new Set(
    (Array.isArray(favoriteNodeIds.value) ? favoriteNodeIds.value : [])
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim())),
  ))

  function isFavoriteNode(uuid: string): boolean {
    return favoriteNodeIdSet.value.has(uuid)
  }

  function toggleFavoriteNode(uuid: string): void {
    const normalized = uuid.trim()
    if (!normalized)
      return
    favoriteNodeIds.value = favoriteNodeIdSet.value.has(normalized)
      ? [...favoriteNodeIdSet.value].filter(id => id !== normalized)
      : [...favoriteNodeIdSet.value, normalized]
  }

  const themeSettings = computed(() => normalizeThemeSettings(publicSettings.value?.theme_settings))
  // Maintenance expiry and Beijing auto theme need the same minute resolution.
  // Sharing one clock avoids keeping two app-lifetime intervals.
  const minuteTick = useNow({ interval: 60_000 })
  const visitorAuditSupported = computed(() => typeof publicSettings.value?.visitor_audit_enabled === 'boolean')
  const visitorAuditEnabled = computed(() => publicSettings.value?.visitor_audit_enabled === true)

  // 首页滚动位置记忆
  const homeScrollPosition = ref<number>(0)

  // 使用 null 表示未设置，等待主题配置加载后决定
  const storedViewMode = useStorageAsync<NodeViewMode | null>('nodeViewMode', null, localStorage)

  // 计算属性：从主题配置获取默认视图模式
  const defaultViewMode = computed<NodeViewMode>(() => {
    const settings = themeSettings.value
    if (typeof settings.defaultViewMode === 'string') {
      const mode = settings.defaultViewMode
      if (mode === 'card' || mode === 'list') {
        return mode
      }
    }
    return 'card'
  })

  // 校验视图模式是否为合法值
  function isValidViewMode(value: string | null): value is NodeViewMode {
    return value === 'card' || value === 'list'
  }

  function isValidNodeCardSize(value: unknown): value is NodeCardSize {
    return value === 'mini' || value === 'compact' || value === 'comfortable' || value === 'large'
  }

  function isValidEarthRenderer(value: unknown): value is EarthRenderer {
    return value === 'realistic' || value === 'cobe' || value === 'tiled'
  }

  const nodeCardSize = computed<NodeCardSize>(() => {
    const settings = themeSettings.value
    if (isValidNodeCardSize(settings.nodeCardSize))
      return settings.nodeCardSize
    return 'compact'
  })

  // 当前实际使用的视图模式
  const nodeViewMode = computed<NodeViewMode>({
    get: () => {
      // 校验 storedViewMode 是否为合法值，非法值时使用默认值
      if (storedViewMode.value !== null && isValidViewMode(storedViewMode.value)) {
        return storedViewMode.value
      }
      return defaultViewMode.value
    },
    set: (val) => {
      storedViewMode.value = val
    },
  })

  // 计算属性：从主题配置获取 RPC 连接模式
  const rpcTransportMode = computed<RpcTransportMode>(() => {
    const settings = themeSettings.value
    if (typeof settings.rpcTransportMode === 'string') {
      const mode = settings.rpcTransportMode
      if (mode === 'websocket' || mode === 'http') {
        return mode
      }
    }
    return 'http'
  })

  // 字节格式化精度（固定配置）
  const byteDecimals: ByteDecimalsConfig = { ...BYTE_DECIMALS }

  // 计算属性：公告配置
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

  const topologyEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'topologyEnabled', true))

  /**
   * 后台自愈是唯一一处无人值守就会写后端（建/删 Ping 任务、改拓扑绑定）的逻辑，
   * 因此给站长一个显式开关；关闭后拓扑管理对话框里的手动操作不受影响。
   */
  const topologyAutoRepairEnabled = computed<boolean>(() => readBooleanSetting(themeSettings.value, 'topologyAutoRepairEnabled', true))

  const topologyRoute = computed<string>(() => readStringSetting(themeSettings.value, 'topologyRoute'))

  const topologyMetrics = computed<string>(() => readStringSetting(themeSettings.value, 'topologyMetrics'))

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

  // 计算属性：自定义背景配置
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

  const lightBackgroundUrl = computed<string>(() => {
    return resolveThemeBackgroundSource(themeSettings.value.lightBackgroundUrl)
  })

  const darkBackgroundUrl = computed<string>(() => {
    return resolveThemeBackgroundSource(themeSettings.value.darkBackgroundUrl)
  })

  const backgroundBlur = computed<number>(() => readNumberSetting(themeSettings.value, 'backgroundBlur', 0, 0, Number.MAX_SAFE_INTEGER))

  const backgroundOverlay = computed<number>(() => readNumberSetting(themeSettings.value, 'backgroundOverlay', 0, -100, 100))

  // 当 publicSettings 加载后，如果 localStorage 没有保存过视图模式或值为非法值，使用默认值
  watch(publicSettings, (settings) => {
    if (settings && !isValidViewMode(storedViewMode.value)) {
      // 触发 computed setter，会自动保存到 localStorage
      storedViewMode.value = defaultViewMode.value
    }
  }, { immediate: true })

  watch(themeMode, (mode) => {
    if (!isValidThemeMode(mode)) {
      themeMode.value = 'auto'
    }
  }, { immediate: true })

  const managedThemeMode = computed<ManagedThemeMode>(() => {
    const value = themeSettings.value.themeMode
    return isValidManagedThemeMode(value) ? value : 'beijing'
  })

  const isBeijingDaytime = computed<boolean>(() => {
    const hour = getBeijingHour(minuteTick.value.getTime())
    return hour >= 7 && hour < 19
  })

  // 计算当前是否为暗色模式。本机按钮选择 auto 时跟随后台托管设置；手动选择浅色/深色时仅覆盖当前浏览器。
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

  // 计算属性：当前主题模式下的背景 URL
  const currentBackgroundUrl = computed<string>(() => {
    if (resolvedThemeMode.value === 'dark') {
      return darkBackgroundUrl.value
    }
    return lightBackgroundUrl.value
  })

  function updateThemeMode(mode?: ThemeMode) {
    if (mode) {
      themeMode.value = isValidThemeMode(mode) ? mode : 'auto'
      return
    }

    const nextMode: Record<ThemeMode, ThemeMode> = {
      auto: 'light',
      light: 'dark',
      dark: 'auto',
    }

    const currentMode = isValidThemeMode(themeMode.value) ? themeMode.value : 'auto'
    themeMode.value = nextMode[currentMode]
  }

  function syncAuthState() {
    const session = getAuthSession()
    isLoggedIn.value = session.authenticated
    authStatus.value = session.status
    return session
  }

  function updateLoginState(loggedIn: boolean, user?: MeInfo | null) {
    setAuthSessionFromLogin(loggedIn, user ?? null)
    syncAuthState()
  }

  async function verifyLoginState(options?: VerifyLoginOptions): Promise<boolean> {
    await verifyLogin(options)
    return syncAuthState().authenticated
  }

  async function requireLoginPermission(permission: PermissionKey, options?: VerifyLoginOptions): Promise<boolean> {
    const result = await requirePermission(permission, options)
    syncAuthState()
    return result.granted
  }

  return {
    loading,
    themeMode,
    managedThemeMode,
    isBeijingDaytime,
    isDark,
    resolvedThemeMode,
    lang,
    nodeSelectedGroup,
    favoriteNodeIds,
    favoriteNodeIdSet,
    isFavoriteNode,
    toggleFavoriteNode,
    nodeViewMode,
    defaultViewMode,
    nodeCardSize,
    rpcTransportMode,
    byteDecimals,
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
    topologyEnabled,
    topologyAutoRepairEnabled,
    topologyRoute,
    topologyMetrics,
    nodeControls,
    nodeCardPanelDefault,
    nodeCardPanels,
    carrierPingRegion,
    generalCardEnabledMap,
    generalCardOrder,
    homeToolsEnabled,
    homeAdvancedToolsVisible,
    glassColorPreset,
    glassCustomColors,
    colorVisionMode,
    colorVisionFriendly,
    visitorAuditSupported,
    visitorAuditEnabled,
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
    backgroundEnabled,
    backgroundType,
    lightBackgroundUrl,
    darkBackgroundUrl,
    currentBackgroundUrl,
    backgroundBlur,
    backgroundOverlay,
    isLoggedIn,
    authStatus,
    privateFeaturesAllowed,
    publicSettings,
    connectionError,
    homeScrollPosition,
    updateThemeMode,
    updateLoginState,
    verifyLoginState,
    requireLoginPermission,
  }
})

export { useAppStore }
export type {
  ChartDashboardCardKey,
  ChartDashboardTemplate,
  DetailMetricCardKey,
  GeneralCardKey,
  GlassCustomColors,
  HomeQuickControlKey,
  ManagedThemeMode,
  NodeListMetadataField,
  ThemeMode,
} from './app.types'
