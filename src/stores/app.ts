import type { PublicSettings } from '@/utils/api'
import type { ByteDecimalsConfig } from '@/utils/helper'
import { usePreferredDark, useStorageAsync } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type ThemeMode = 'auto' | 'light' | 'dark'
export type GeneralCardKey
  = | 'memory'
    | 'disk'
    | 'remainingValue'
    | 'totalTraffic'
    | 'uploadSpeed'
    | 'downloadSpeed'
    | 'onlineNodes'
    | 'avgCpu'
    | 'avgLoad'
    | 'swap'
    | 'processes'
    | 'connections'
    | 'avgTemperature'
    | 'cpuCores'
    | 'trafficQuota'

type Lang = 'zh-CN' | 'en-US'
type NodeViewMode = 'card' | 'list'
type NodeCardSize = 'compact' | 'comfortable' | 'large'
type RpcTransportMode = 'websocket' | 'http'

/** 固定的字节精度配置 */
const BYTE_DECIMALS: ByteDecimalsConfig = {
  B: 0,
  KB: 0,
  MB: 1,
  GB: 1,
  TB: 2,
}

const DEFAULT_GENERAL_CARD_ORDER: GeneralCardKey[] = [
  'memory',
  'disk',
  'remainingValue',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
]

const ALL_GENERAL_CARD_KEYS = [
  ...DEFAULT_GENERAL_CARD_ORDER,
  'onlineNodes',
  'avgCpu',
  'avgLoad',
  'swap',
  'processes',
  'connections',
  'avgTemperature',
  'cpuCores',
  'trafficQuota',
] as const satisfies readonly GeneralCardKey[]

const DEFAULT_GENERAL_CARD_ENABLED: Record<GeneralCardKey, boolean> = {
  memory: true,
  disk: true,
  remainingValue: true,
  totalTraffic: true,
  uploadSpeed: true,
  downloadSpeed: true,
  onlineNodes: false,
  avgCpu: false,
  avgLoad: false,
  swap: false,
  processes: false,
  connections: false,
  avgTemperature: false,
  cpuCores: false,
  trafficQuota: false,
}

const GENERAL_CARD_SETTING_KEYS: Record<GeneralCardKey, string> = {
  memory: 'generalCardMemoryEnabled',
  disk: 'generalCardDiskEnabled',
  remainingValue: 'generalCardRemainingValueEnabled',
  totalTraffic: 'generalCardTotalTrafficEnabled',
  uploadSpeed: 'generalCardUploadSpeedEnabled',
  downloadSpeed: 'generalCardDownloadSpeedEnabled',
  onlineNodes: 'generalCardOnlineNodesEnabled',
  avgCpu: 'generalCardAvgCpuEnabled',
  avgLoad: 'generalCardAvgLoadEnabled',
  swap: 'generalCardSwapEnabled',
  processes: 'generalCardProcessesEnabled',
  connections: 'generalCardConnectionsEnabled',
  avgTemperature: 'generalCardAvgTemperatureEnabled',
  cpuCores: 'generalCardCpuCoresEnabled',
  trafficQuota: 'generalCardTrafficQuotaEnabled',
}

function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark'
}

function isGeneralCardKey(value: string): value is GeneralCardKey {
  return (ALL_GENERAL_CARD_KEYS as readonly string[]).includes(value)
}

const useAppStore = defineStore('app', () => {
  const loading = ref<boolean>(true)

  // 使用 VueUse 的 useStorageAsync 实现自动持久化
  const themeMode = useStorageAsync<ThemeMode>('themeMode', 'auto', localStorage)
  const lang = ref<Lang>('zh-CN')
  const publicSettings = ref<PublicSettings>()
  const nodeSelectedGroup = useStorageAsync<string>('nodeSelectedGroup', 'all', localStorage)
  const isLoggedIn = ref<boolean>(false)
  const connectionError = ref<boolean>(false)

  // 首页滚动位置记忆
  const homeScrollPosition = ref<number>(0)

  // 使用 null 表示未设置，等待主题配置加载后决定
  const storedViewMode = useStorageAsync<NodeViewMode | null>('nodeViewMode', null, localStorage)

  // 计算属性：从主题配置获取默认视图模式
  const defaultViewMode = computed<NodeViewMode>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.defaultViewMode === 'string') {
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
    return value === 'compact' || value === 'comfortable' || value === 'large'
  }

  const nodeCardSize = computed<NodeCardSize>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && isValidNodeCardSize(settings.nodeCardSize))
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
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.rpcTransportMode === 'string') {
      const mode = settings.rpcTransportMode
      if (mode === 'websocket' || mode === 'http') {
        return mode
      }
    }
    return 'websocket'
  })

  // 字节格式化精度（固定配置）
  const byteDecimals: ByteDecimalsConfig = { ...BYTE_DECIMALS }

  // 计算属性：公告配置
  const alertEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.alertEnabled === 'boolean') {
      return settings.alertEnabled
    }
    return false
  })

  const alertTitle = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.alertTitle === 'string') {
      return settings.alertTitle
    }
    return ''
  })

  const alertContent = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.alertContent === 'string') {
      return settings.alertContent
    }
    return ''
  })

  const stopEarth = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.stopEarth === 'boolean') {
      return settings.stopEarth
    }
    return false
  })

  const hideEarth = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.hideEarth === 'boolean') {
      return settings.hideEarth
    }
    return false
  })

  const hideGeneralCard = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.hideGeneralCard === 'boolean') {
      return settings.hideGeneralCard
    }
    return false
  })

  const visitorInfoEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.visitorInfoEnabled === 'boolean')
      return settings.visitorInfoEnabled
    return true
  })

  const visitorGeoArcEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.visitorGeoArcEnabled === 'boolean')
      return settings.visitorGeoArcEnabled
    return true
  })

  const generalCardEnabledMap = computed<Record<GeneralCardKey, boolean>>(() => {
    const settings = publicSettings.value?.theme_settings
    const enabledMap = { ...DEFAULT_GENERAL_CARD_ENABLED }

    if (!settings)
      return enabledMap

    for (const key of ALL_GENERAL_CARD_KEYS) {
      const settingKey = GENERAL_CARD_SETTING_KEYS[key]
      const value = settings[settingKey]
      if (typeof value === 'boolean')
        enabledMap[key] = value
    }

    return enabledMap
  })

  const generalCardOrder = computed<GeneralCardKey[]>(() => {
    const settings = publicSettings.value?.theme_settings
    const rawOrder = settings?.generalCardOrder
    const parsedOrder: GeneralCardKey[] = []
    const seenKeys = new Set<GeneralCardKey>()

    if (typeof rawOrder === 'string') {
      for (const item of rawOrder.split(',')) {
        const key = item.trim()
        if (!isGeneralCardKey(key) || seenKeys.has(key))
          continue
        parsedOrder.push(key)
        seenKeys.add(key)
      }
    }

    const orderedKeys = parsedOrder.length > 0 ? [...parsedOrder] : [...DEFAULT_GENERAL_CARD_ORDER]
    const orderedKeySet = new Set<GeneralCardKey>(orderedKeys)
    for (const key of ALL_GENERAL_CARD_KEYS) {
      if (orderedKeySet.has(key))
        continue
      orderedKeys.push(key)
      orderedKeySet.add(key)
    }

    return orderedKeys.filter(key => generalCardEnabledMap.value[key])
  })

  const hideAdminEntryWhenLoggedOut = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.hideAdminEntryWhenLoggedOut === 'boolean') {
      return settings.hideAdminEntryWhenLoggedOut
    }
    return false
  })

  const hidePriceWhenLoggedOut = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.hidePriceWhenLoggedOut === 'boolean') {
      return settings.hidePriceWhenLoggedOut
    }
    return false
  })

  const providerAliases = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.providerAliases === 'string')
      return settings.providerAliases.trim()
    return ''
  })

  const disablePageAnimation = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.disablePageAnimation === 'boolean') {
      return settings.disablePageAnimation
    }
    return false
  })

  // 计算属性：ICP 备案配置
  const icpEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.icpEnabled === 'boolean') {
      return settings.icpEnabled
    }
    return false
  })

  const icpNumber = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.icpNumber === 'string') {
      return settings.icpNumber
    }
    return ''
  })

  const icpUrl = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.icpUrl === 'string' && settings.icpUrl.trim()) {
      return settings.icpUrl.trim()
    }
    return 'https://beian.miit.gov.cn/'
  })

  // 计算属性：公安备案配置
  const policeEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.policeEnabled === 'boolean') {
      return settings.policeEnabled
    }
    return false
  })

  const policeNumber = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.policeNumber === 'string') {
      return settings.policeNumber
    }
    return ''
  })

  const policeUrl = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.policeUrl === 'string' && settings.policeUrl.trim()) {
      return settings.policeUrl.trim()
    }
    return ''
  })

  // 计算属性：自定义背景配置
  const backgroundEnabled = computed<boolean>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.backgroundEnabled === 'boolean') {
      return settings.backgroundEnabled
    }
    return false
  })

  const backgroundType = computed<'image' | 'video'>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.backgroundType === 'string') {
      const type = settings.backgroundType
      if (type === 'image' || type === 'video') {
        return type
      }
    }
    return 'image'
  })

  const lightBackgroundUrl = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.lightBackgroundUrl === 'string') {
      return settings.lightBackgroundUrl.trim()
    }
    return ''
  })

  const darkBackgroundUrl = computed<string>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.darkBackgroundUrl === 'string') {
      return settings.darkBackgroundUrl.trim()
    }
    return ''
  })

  const backgroundBlur = computed<number>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.backgroundBlur === 'number' && settings.backgroundBlur >= 0) {
      return settings.backgroundBlur
    }
    return 0
  })

  const backgroundOverlay = computed<number>(() => {
    const settings = publicSettings.value?.theme_settings
    if (settings && typeof settings.backgroundOverlay === 'number' && settings.backgroundOverlay >= -100 && settings.backgroundOverlay <= 100) {
      return settings.backgroundOverlay
    }
    return 0
  })

  // 当 publicSettings 加载后，如果 localStorage 没有保存过视图模式或值为非法值，使用默认值
  watch(publicSettings, (settings) => {
    if (settings && !isValidViewMode(storedViewMode.value)) {
      // 触发 computed setter，会自动保存到 localStorage
      storedViewMode.value = defaultViewMode.value
    }
  }, { immediate: true })

  // 使用 VueUse 的 usePreferredDark 检测系统主题偏好
  const prefersDark = usePreferredDark()

  watch(themeMode, (mode) => {
    if (!isValidThemeMode(mode)) {
      themeMode.value = 'auto'
    }
  }, { immediate: true })

  // 计算当前是否为暗色模式
  const isDark = computed(() => {
    if (themeMode.value === 'auto') {
      return prefersDark.value
    }
    return themeMode.value === 'dark'
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

  function updateLoginState(loggedIn: boolean) {
    isLoggedIn.value = loggedIn
  }

  return {
    loading,
    themeMode,
    isDark,
    resolvedThemeMode,
    lang,
    nodeSelectedGroup,
    nodeViewMode,
    defaultViewMode,
    nodeCardSize,
    rpcTransportMode,
    byteDecimals,
    alertEnabled,
    alertTitle,
    alertContent,
    stopEarth,
    hideEarth,
    hideGeneralCard,
    visitorInfoEnabled,
    visitorGeoArcEnabled,
    generalCardEnabledMap,
    generalCardOrder,
    hideAdminEntryWhenLoggedOut,
    hidePriceWhenLoggedOut,
    providerAliases,
    disablePageAnimation,
    icpEnabled,
    icpNumber,
    icpUrl,
    policeEnabled,
    policeNumber,
    policeUrl,
    backgroundEnabled,
    backgroundType,
    lightBackgroundUrl,
    darkBackgroundUrl,
    currentBackgroundUrl,
    backgroundBlur,
    backgroundOverlay,
    isLoggedIn,
    publicSettings,
    connectionError,
    homeScrollPosition,
    updateThemeMode,
    updateLoginState,
  }
})

export { useAppStore }
