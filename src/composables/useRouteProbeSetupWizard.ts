import type { MaybeRefOrGetter } from 'vue'
import type { CompanionStorageHealth } from '@/services/route-probe-companion.service'
import type { NodeData } from '@/stores/nodes'
import { computed, onScopeDispose, ref, toValue } from 'vue'
import { TIME_MS } from '@/constants/time'
import { requirePermission } from '@/services/auth.service'
import {
  getCompanionRouteProbeHealth,
  getCompanionRouteProbeRoster,
  RouteProbeCompanionUnavailableError,
} from '@/services/route-probe-companion.service'
import { isRouteProbeOnlineNode, loadRouteProbeNodeTokens } from '@/services/route-probe.service'
import { saveManagedThemeSettings } from '@/services/theme-settings.service'
import { useAppStore } from '@/stores/app'
import { getRegionCode } from '@/utils/regionHelper'
import { buildRouteProbeInstallCommand } from '@/utils/routeProbeInstall'

export { buildRouteProbeInstallCommand } from '@/utils/routeProbeInstall'

/**
 * 三网回程检测设置向导：环境检查 → 安装节点助手 → 启用检测。
 *
 * 环境检查阶段只读取已有数据（伴生插件 `/health`、花名册 `/roster`），不入队、
 * 不触发任何一次 traceroute——这是 `roster()` 存在的意义，见
 * `companion/transit-route-probe/protocol.cjs`。真正会执行命令的只有最后一步
 * 写入 `routeProbeEnabled: true` 之后，由 `NodeRouteProbeButton` 的自动检测接手。
 *
 * 助手每 15 秒轮询一次；判定离线的窗口留了将近三个轮询周期（40 秒，而不是卡
 * 死在 2×15=30 秒），给网络抖动和请求排队留出余量，避免单次抖动误报「未连接」。
 */
const HELPER_ONLINE_WINDOW_MS = 40 * TIME_MS.second
/**
 * 花名册接口用一次 GET 查询字符串传所有 UUID；查询串太长可能撞上反代的 URL/
 * 请求行长度限制，所以分批粒度比后端上限（`ROSTER_MAX_CLIENTS`=200）小得多，
 * 和 `enqueue` 的批量上限（`ROUTE_PROBE_MAX_NODES`=20）保持同一数量级。
 */
const ROSTER_CHUNK_SIZE = 20
/**
 * 安装完助手后不该逼运营者自己点“重新检查”——助手 15 秒轮询一次，装完很快就
 * 会在花名册里露面，这里用同样的节奏自动补一次，装完基本不用等。
 */
const ROSTER_REFRESH_INTERVAL_MS = 15 * TIME_MS.second

export type WizardStep = 'check' | 'confirm'

export interface RouteProbeSetupNode {
  uuid: string
  name: string
  helperOnline: boolean
  helperBusy: boolean
  helperVersion: string | null
  helperVersionMatches: boolean | null
  lastJobAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastDurationMs: number | null
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size))
  return chunks
}

export function useRouteProbeSetupWizard(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const step = ref<WizardStep>('check')
  const checking = ref(false)
  const checkError = ref('')
  const pluginInstalled = ref<boolean | null>(null)
  const pluginVersion = ref<string | null>(null)
  const pluginStorage = ref<CompanionStorageHealth>()
  const eligibleNodes = ref<RouteProbeSetupNode[]>([])
  const mainlandCount = ref(0)
  const saving = ref(false)
  const saveError = ref('')
  const nodeTokens = ref<Record<string, string>>({})
  // 弹窗关闭即丢弃这个组合式实例，但已经发出的请求不会因此停下——挂个
  // AbortController 让 dispose 时能真的取消掉，和 useRouteProbe.ts 的做法一致。
  const controller = new AbortController()
  onScopeDispose(() => controller.abort())

  const missingHelperNodes = computed(() => eligibleNodes.value.filter(node => !node.helperOnline))
  const onlineHelperNodes = computed(() => eligibleNodes.value.filter(node => node.helperOnline))
  const mismatchedHelperNodes = computed(() => onlineHelperNodes.value.filter(node => node.helperVersionMatches === false))
  const legacyHelperNodes = computed(() => onlineHelperNodes.value.filter(node => node.helperVersionMatches === null))
  const onlineHelperCount = computed(() => eligibleNodes.value.length - missingHelperNodes.value.length)
  // 检查出错时不能让运营者带着一次不完整的结果直接启用——哪怕插件确认已装。
  const canEnable = computed(() => pluginInstalled.value === true && !checkError.value)
  let refreshing = false
  let rosterGeneration = 0

  /**
   * 离线节点和没有 uuid 的节点直接跳过，不计入任何一边——`isRouteProbeOnlineNode`
   * 和真正下发探测的 `selectRouteProbeCandidates` 共用同一个判断，避免两边口径
   * 各自漂移，让「N 台助手在线」和启用后实际会测的台数对不上。
   */
  function classifyNodes(): { eligible: { uuid: string, name: string }[], mainland: number } {
    let mainland = 0
    const eligible: { uuid: string, name: string }[] = []
    for (const node of toValue(nodes)) {
      if (!isRouteProbeOnlineNode(node))
        continue
      if (getRegionCode(node.region) === 'CN') {
        mainland += 1
        continue
      }
      eligible.push({ uuid: node.uuid, name: node.name || node.uuid })
    }
    return { eligible, mainland }
  }

  /** 查花名册并按在线窗口分类；runCheck 和后台自动刷新共用同一套判定。 */
  async function classifyHelperStatus(candidates: readonly { uuid: string, name: string }[]): Promise<RouteProbeSetupNode[]> {
    const roster = new Map<string, Awaited<ReturnType<typeof getCompanionRouteProbeRoster>>[number]>()
    const groups = await Promise.all(
      chunk(candidates.map(node => node.uuid), ROSTER_CHUNK_SIZE).map(group => getCompanionRouteProbeRoster(group, controller.signal)),
    )
    for (const entries of groups) {
      for (const entry of entries)
        roster.set(entry.client, entry)
    }
    const now = Date.now()
    return candidates.map((node) => {
      const state = roster.get(node.uuid)
      const lastSeen = state?.helper_seen_at ?? null
      const version = state?.helper_version ?? null
      const helperBusy = (state?.active_job_until ?? 0) > now
      return {
        ...node,
        helperOnline: helperBusy || (lastSeen !== null && now - lastSeen <= HELPER_ONLINE_WINDOW_MS),
        helperBusy,
        helperVersion: version,
        helperVersionMatches: version ? version === __BUILD_VERSION__ : null,
        lastJobAt: state?.last_job_at ?? null,
        lastSuccessAt: state?.last_success_at ?? null,
        lastError: state?.last_error ?? null,
        lastDurationMs: state?.last_duration_ms ?? null,
      }
    })
  }

  /** 环境检查：只读，不下发任何任务。 */
  async function runCheck(): Promise<void> {
    checking.value = true
    checkError.value = ''
    const generation = ++rosterGeneration
    try {
      const permission = await requirePermission('advancedTools', { force: true })
      if (!permission.granted)
        throw new Error('登录状态已过期，请重新登录后再试。')

      const { eligible, mainland } = classifyNodes()
      mainlandCount.value = mainland

      try {
        const health = await getCompanionRouteProbeHealth(controller.signal)
        pluginInstalled.value = true
        pluginVersion.value = health.version
        pluginStorage.value = health.storage
      }
      catch (error) {
        if (!(error instanceof RouteProbeCompanionUnavailableError))
          throw error
        pluginInstalled.value = false
        pluginVersion.value = null
        pluginStorage.value = undefined
        if (generation !== rosterGeneration)
          return
        eligibleNodes.value = eligible.map(node => ({
          ...node,
          helperOnline: false,
          helperBusy: false,
          helperVersion: null,
          helperVersionMatches: null,
          lastJobAt: null,
          lastSuccessAt: null,
          lastError: null,
          lastDurationMs: null,
        }))
        await loadMissingHelperTokens()
        return
      }

      const classified = await classifyHelperStatus(eligible)
      if (generation !== rosterGeneration)
        return
      eligibleNodes.value = classified
      await loadMissingHelperTokens()
    }
    catch (error) {
      checkError.value = error instanceof Error ? error.message : '环境检查失败'
    }
    finally {
      checking.value = false
    }
  }

  /**
   * 后台自动补测：装完助手后不用手动点“重新检查”。插件已确认安装且有节点时
   * 持续更新（包括执行租约过期），没有别的检查正在跑时才做事；失败静默吞掉，
   * 不该用告警打断运营者，出问题时手动“重新检查”仍会完整校验并报错。不重复
   * `requirePermission`，会话校验已在 `runCheck` 里做过。
   *
   * `refreshing` 是这个函数自己的重入锁：`checking` 只在 `runCheck` 里置位，
   * 挡不住这个函数被两次定时器 tick 同时触发——上一轮还没返回、下一轮 15 秒
   * 又到了的话，两次请求谁先回来谁写结果，慢的那次可能用过期数据覆盖新结果，
   * 把刚上线的节点重新判成缺助手。
   */
  async function refreshMissingHelpers(): Promise<void> {
    if (refreshing || step.value !== 'check' || checking.value || pluginInstalled.value !== true || !eligibleNodes.value.length)
      return
    refreshing = true
    const generation = rosterGeneration
    try {
      const next = await classifyHelperStatus(eligibleNodes.value)
      if (generation !== rosterGeneration || checking.value)
        return
      eligibleNodes.value = next
      await loadMissingHelperTokens()
    }
    catch {
      // 静默失败，等下一轮定时器或手动重新检查。
    }
    finally {
      refreshing = false
    }
  }

  const refreshTimer = setInterval(() => {
    void refreshMissingHelpers()
  }, ROSTER_REFRESH_INTERVAL_MS)
  onScopeDispose(() => clearInterval(refreshTimer))

  /**
   * 缺助手的节点集合没变时跳过重新拉取。Agent token 是静态的，不会随时间
   * 改变；`refreshMissingHelpers` 每 15 秒都会调用这里一次，环境检查开着期间
   * 只要还有一台没装助手，之前的实现就会一直重新拉一遍全节点表外加所有 token，
   * 而通常这段时间里缺助手的那批节点根本没变化。
   */
  let missingHelperTokenKey: string | null = null

  async function loadMissingHelperTokens(): Promise<void> {
    const generation = rosterGeneration
    const missing = missingHelperNodes.value.map(node => node.uuid)
    if (!missing.length) {
      missingHelperTokenKey = null
      nodeTokens.value = {}
      return
    }
    const key = [...missing].sort().join(',')
    if (key === missingHelperTokenKey)
      return
    const tokens = await loadRouteProbeNodeTokens(missing, controller.signal)
    if (generation !== rosterGeneration)
      return
    missingHelperTokenKey = key
    nodeTokens.value = tokens
  }

  async function loadNodeTokens(): Promise<void> {
    await loadMissingHelperTokens()
  }

  /**
   * 安装命令本身不带 token，所有节点共用同一段：`--endpoint` 和 `--token`/
   * `--token-file` 都不传时，`helper.sh` 会用 `read -s` 交互式提示输入 token，
   * 既不出现在这条命令的 shell 历史里，也不会在 `ps` 里露出来。真正的 token
   * 通过 `tokenFor()` 单独复制，运行到提示时再粘贴。
   */
  const installEndpoint = computed(() => typeof window === 'undefined' ? '' : window.location.origin)
  const installCommand = computed(() => {
    const release = `v${__BUILD_VERSION__}`
    return buildRouteProbeInstallCommand(installEndpoint.value, release)
  })

  function tokenFor(uuid: string): string {
    return nodeTokens.value[uuid] ?? ''
  }

  function goToConfirm(): void {
    step.value = 'confirm'
  }

  function goToCheck(): void {
    step.value = 'check'
  }

  /** 最后一步：写入总开关。首次自动检测由 `NodeRouteProbeButton` 的轮询接手。 */
  async function enable(): Promise<boolean> {
    const theme = appStore.publicSettings?.theme
    if (!theme) {
      saveError.value = '站点配置尚未加载完成。'
      return false
    }
    saving.value = true
    saveError.value = ''
    try {
      await saveManagedThemeSettings({
        theme,
        patch: { routeProbeEnabled: true },
        permission: 'advancedTools',
        requestKey: `route-probe-setup:${theme}`,
        onPublicSettings: appStore.applyPublicSettings,
      })
      return true
    }
    catch (error) {
      saveError.value = error instanceof Error ? error.message : '启用失败'
      return false
    }
    finally {
      saving.value = false
    }
  }

  function reset(): void {
    step.value = 'check'
    checkError.value = ''
    saveError.value = ''
    pluginInstalled.value = null
    pluginVersion.value = null
    pluginStorage.value = undefined
    eligibleNodes.value = []
    mainlandCount.value = 0
    nodeTokens.value = {}
    missingHelperTokenKey = null
  }

  return {
    step,
    checking,
    checkError,
    pluginInstalled,
    pluginVersion,
    pluginStorage,
    eligibleNodes,
    mainlandCount,
    missingHelperNodes,
    onlineHelperNodes,
    mismatchedHelperNodes,
    legacyHelperNodes,
    onlineHelperCount,
    canEnable,
    saving,
    saveError,
    runCheck,
    loadNodeTokens,
    installEndpoint,
    installCommand,
    tokenFor,
    goToConfirm,
    goToCheck,
    enable,
    reset,
  }
}
