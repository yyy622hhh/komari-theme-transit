import type {
  Lang,
  NodeCardSize,
  NodeViewMode,
  RpcTransportMode,
  ThemeMode,
} from './app.types'
import type { PermissionKey, VerifyLoginOptions } from '@/services/auth.service'
import type { MeInfo } from '@/utils/api'
import type { ByteDecimalsConfig } from '@/utils/helper'
import { useNow, useStorageAsync } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { getAuthSession, requirePermission, setAuthSessionFromLogin, subscribeAuthSession, verifyLogin } from '@/services/auth.service'
import { createBackgroundSettings } from '@/stores/app.background'
import { createDisplaySettings } from '@/stores/app.displaySettings'
import { usePublicSettingsState } from '@/stores/app.publicSettings'
import { createThemeModeState } from '@/stores/app.themeMode'
import { createTopologySettings } from '@/stores/app.topologySettings'
import { normalizeThemeSettings } from '@/utils/themeSettings'
import { BYTE_DECIMALS, isValidThemeMode } from './app.settings'

const useAppStore = defineStore('app', () => {
  const loading = ref<boolean>(true)

  const themeMode = useStorageAsync<ThemeMode>('themeMode', 'auto', localStorage)
  const lang = ref<Lang>('zh-CN')
  const { publicSettings, publicSettingsEpoch, applyPublicSettings, applyFetchedPublicSettings } = usePublicSettingsState()
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
  // Maintenance expiry, Beijing auto theme and return-route freshness need the same
  // minute resolution. Sharing one clock avoids keeping several app-lifetime intervals.
  const minuteTick = useNow({ interval: 60_000 })
  const visitorAuditSupported = computed(() => typeof publicSettings.value?.visitor_audit_enabled === 'boolean')
  const visitorAuditEnabled = computed(() => publicSettings.value?.visitor_audit_enabled === true)

  const homeScrollPosition = ref<number>(0)

  const storedViewMode = useStorageAsync<NodeViewMode | null>('nodeViewMode', null, localStorage)

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

  function isValidViewMode(value: string | null): value is NodeViewMode {
    return value === 'card' || value === 'list'
  }

  function isValidNodeCardSize(value: unknown): value is NodeCardSize {
    return value === 'mini' || value === 'compact' || value === 'comfortable' || value === 'large'
  }

  const nodeCardSize = computed<NodeCardSize>(() => {
    const settings = themeSettings.value
    if (isValidNodeCardSize(settings.nodeCardSize))
      return settings.nodeCardSize
    return 'compact'
  })

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

  const {
    topologyEnabled,
    topologyAutoRepairEnabled,
    routeProbeEnabled,
    topologyConfig,
    topologyRoute,
    topologyMetrics,
  } = createTopologySettings(themeSettings)

  const {
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
  } = createDisplaySettings(themeSettings, minuteTick)

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

  const { managedThemeMode, isBeijingDaytime, isDark, resolvedThemeMode } = createThemeModeState(themeSettings, themeMode, minuteTick)

  const {
    backgroundEnabled,
    backgroundType,
    lightBackgroundUrl,
    darkBackgroundUrl,
    currentBackgroundUrl,
    backgroundBlur,
    backgroundOverlay,
  } = createBackgroundSettings(themeSettings, resolvedThemeMode)

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
    routeProbeEnabled,
    topologyConfig,
    topologyRoute,
    topologyMetrics,
    nodeControls,
    /** 全站共享的分钟时钟，供「多久之前」这类相对时间显示保持自动刷新。 */
    minuteTick,
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
    publicSettingsEpoch,
    applyPublicSettings,
    applyFetchedPublicSettings,
    connectionError,
    homeScrollPosition,
    updateThemeMode,
    updateLoginState,
    verifyLoginState,
    requireLoginPermission,
  }
})

export { useAppStore }
export type * from './app.types'
