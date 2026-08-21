import type { MaybeRefOrGetter } from 'vue'
import type { RouteProbeOutcome } from '@/services/route-probe.service'
import type { NodeData } from '@/stores/nodes'
import type { RouteTraceCity } from '@/utils/routeTrace'
import { computed, onScopeDispose, ref, toValue } from 'vue'
import { TIME_MS } from '@/constants/time'
import { probeNodeRoutes, selectRouteProbeCandidates } from '@/services/route-probe.service'
import { useAppStore } from '@/stores/app'
import { isRpcPermissionError } from '@/utils/rpc'
import { logAppWarning } from '@/utils/safeError'

/**
 * 三网回程采集的 Vue 生命周期胶水。判定与写入全在
 * `services/route-probe.service.ts`（纯函数部分有单测），这里只负责触发时机。
 *
 * 这是主题里唯一会让别人的服务器执行命令的路径，所以「什么时候不跑」比「什么
 * 时候跑」更重要。除了显式总开关，下面的约束都由主题强制执行：
 *
 * 1. **显式启用**：默认不加载候选、不显示入口，也不向节点下发任务。
 * 2. **挑节点**：只有「非中国大陆、在线，且标签缺失或已过期（7 天）」的节点进
 *    候选。回程几周才变一次，这一条就把频率压到每台约每周一次。运营者手动点
 *    按钮时可以传 `force` 跳过新鲜度这一条（见 `probeNow`），但自动轮询永远
 *    不会这样做。
 * 3. **同源浏览器节流**：同一站点的页面和标签页共享 30 分钟冷却时间。
 * 4. **单飞**：正在跑的时候不再开第二轮。
 * 5. **后台标签页不跑**：见 `pageIsVisible`。
 * 6. **失败不重试**：见 `autoSkipped`，避免在跑不通的机器上反复执行命令。
 * 7. **没权限就停**：见 `autoBlocked`，2FA 场景下不做无意义的循环重试。
 *
 * 跨标签页的重复下发再由 localStorage 冷却时间直接压住；不同设备之间不共享浏览器
 * 存储，仍由候选标签与单轮失败跳过控制。
 */

/** 同一浏览器、同一站点的两轮自动采集之间的最小间隔。 */
const AUTO_PROBE_COOLDOWN_MS = 30 * TIME_MS.minute
const AUTO_PROBE_STORAGE_KEY = 'transit:route-probe:last-auto-run-at'

/** 浏览器存储不可用时保持静默降级，不能让节流本身挡住手动检测。 */
function readSharedAutoRunAt(): number {
  if (typeof localStorage === 'undefined')
    return 0
  try {
    const value = Number(localStorage.getItem(AUTO_PROBE_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  catch {
    return 0
  }
}

function writeSharedAutoRunAt(value: number): void {
  if (typeof localStorage === 'undefined')
    return
  try {
    localStorage.setItem(AUTO_PROBE_STORAGE_KEY, String(value))
  }
  catch {
    // 隐私模式或存储配额不该影响检测主流程。
  }
}

/**
 * 后台标签页不自动采集。
 *
 * 一是别在用户看不见的地方往他的服务器上发命令；二是多开标签页时，各自有各自的
 * 冷却计时，同一批候选可能被同时下发——只有先写回标签的那一轮才会让别人算空，
 * 中间存在竞态窗口。只让当前可见的那个标签页跑，能把这个窗口压到最小。
 */
function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * 复检间隔。
 *
 * 不能只在页面打开后定时一次：首屏的鉴权和节点列表都是异步的，那一刻可能还没
 * 登录、或者节点还没到，一次性定时器打空之后就再也不会重来，「自动检测」就成了
 * 摆设。改成按间隔复检——条件不满足时的早退不会写 `lastRunAt`，所以复检很便宜，
 * 真正的频率由候选条件和冷却时间控制。
 */
const AUTO_PROBE_CHECK_INTERVAL_MS = 20 * TIME_MS.second

export function useRouteProbe(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const probing = ref(false)
  const lastError = ref('')
  const lastOutcomes = ref<RouteProbeOutcome[]>([])
  let disposed = false
  let lastRunAt = 0
  /**
   * 权限类失败后停掉自动触发（手动按钮不受影响）。
   *
   * `admin:exec` 属于敏感操作：管理员账号开了 2FA 时，没有验证码的调用一律 401。
   * 那不是「这次不巧」，是这个账号在这个环境下就是不行——再自动重试也只会每半
   * 小时失败一次，永远不会好。
   */
  let autoBlocked = false
  /**
   * 本会话里已经试过、但拿不到结果的节点。
   *
   * 这类节点（没装 traceroute、被防火墙拦死）永远写不出标签，也就永远留在候选
   * 里。不记住它们的话，自动触发会每半小时在同一批机器上重跑一次命令，一直到
   * 页面关闭为止——在别人的服务器上反复执行命令，代价不该这么随意地付。
   * 手动按钮不受影响：运营者装好 traceroute 之后点一下就能重试。
   */
  const autoSkipped = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let controller: AbortController | null = null

  /**
   * 当前有多少台节点该测。按钮显示这个数字，所以它要算上「自动跳过」的那些——
   * 那些节点确实还没测出结果，运营者修好环境后正是要靠这个按钮重试。
   *
   * `force: true` 用来算「如果运营者要求强制重测，会有多少台」，与自动节流的
   * 候选数是两个独立的数字：全部节点都新鲜时前者为 0，后者仍然等于在线且非
   * 中国大陆的节点数，按钮据此决定是显示「检测回程 N」还是「重新检测回程 N」。
   */
  function pendingCount(force = false): number {
    if (!appStore.routeProbeEnabled)
      return 0
    return selectRouteProbeCandidates(toValue(nodes), Date.now(), new Set(), force).length
  }

  /**
   * 跟着三网质量那一行的地区设置走，不另设一个采集地区。运营者已经选过关心哪
   * 个地区，两处用同一个来源才不会出现「卡片看广东、回程测北京」的错位。
   * 「多地区均值」没有对应的单一城市，退回北京。
   */
  function probeCity(): RouteTraceCity {
    const mapping: Record<string, RouteTraceCity> = {
      beijing: 'beijing',
      shanghai: 'shanghai',
      guangdong: 'guangzhou',
    }
    return mapping[appStore.carrierPingRegion] ?? 'beijing'
  }

  async function run(trigger: 'manual' | 'auto', force = false): Promise<void> {
    if (disposed || probing.value)
      return
    // 只有已登录管理员能执行远程命令；未登录时连候选都不算。
    if (!appStore.privateFeaturesAllowed)
      return
    // 这是总开关：关闭时自动和手动路径都不能下发任务。
    if (!appStore.routeProbeEnabled)
      return
    if (trigger === 'auto' && autoBlocked)
      return
    if (trigger === 'auto' && !pageIsVisible())
      return
    const sharedLastRunAt = trigger === 'auto' ? readSharedAutoRunAt() : 0
    if (trigger === 'auto' && Math.max(lastRunAt, sharedLastRunAt) > 0
      && Date.now() - Math.max(lastRunAt, sharedLastRunAt) < AUTO_PROBE_COOLDOWN_MS) {
      return
    }

    // 手动触发时把「试过也没用」的清单一并作废，让运营者修好环境后能立刻重试。
    if (trigger === 'manual')
      autoSkipped.clear()
    // 跳过清单要交给挑选函数在截断台数之前用掉，不能等拿到结果再过滤。
    // force 只在手动触发时才可能为 true——自动轮询永远不该跳过新鲜度检查，
    // 否则每 20 秒就会在所有节点上重新执行一遍命令。
    const candidates = selectRouteProbeCandidates(toValue(nodes), Date.now(), autoSkipped, trigger === 'manual' && force)
    if (!candidates.length)
      return

    probing.value = true
    lastRunAt = Date.now()
    if (trigger === 'auto')
      writeSharedAutoRunAt(lastRunAt)
    controller = new AbortController()
    try {
      const summary = await probeNodeRoutes(candidates, probeCity(), { trigger, signal: controller.signal })
      if (summary && !disposed) {
        lastOutcomes.value = summary.outcomes
        lastError.value = ''
        for (const outcome of summary.outcomes) {
          if (outcome.status !== 'updated')
            autoSkipped.add(outcome.uuid)
        }
      }
    }
    catch (error) {
      if (disposed)
        return
      const permissionDenied = isRpcPermissionError(error)
      if (permissionDenied && trigger === 'auto')
        autoBlocked = true
      const message = permissionDenied
        ? '没有远程执行权限，无法自动检测回程；管理员账号启用 2FA 时属正常情况，可改用节点侧采集脚本。'
        : error instanceof Error && error.message.trim() ? error.message : '三网回程检测失败'
      lastError.value = message
      // 自动触发的失败不打扰用户，只留一条控制台告警和按钮上的提示。
      logAppWarning('route-probe', message)
    }
    finally {
      probing.value = false
      controller = null
    }
  }

  /**
   * 手动触发：忽略节流。默认仍然只测该测的那些节点；`force: true` 时连新鲜度
   * 也一并跳过，用于运营者明确要求「我现在就要重新测一遍」的场景。
   */
  function probeNow(force = false): Promise<void> {
    return run('manual', force)
  }

  if (typeof window !== 'undefined') {
    timer = setInterval(() => {
      void run('auto')
    }, AUTO_PROBE_CHECK_INTERVAL_MS)
  }

  onScopeDispose(() => {
    disposed = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    controller?.abort()
  })

  /**
   * 上一轮结果的一句话摘要。
   *
   * 没有它的话，「节点没装 traceroute」这类失败会彻底静默：写回流水只记真正发生
   * 的后端写入，而这类节点在写回之前就返回了，运营者哪里都看不到。
   */
  const lastSummary = computed(() => {
    if (lastError.value)
      return lastError.value
    if (!lastOutcomes.value.length)
      return ''
    const counts = { 'updated': 0, 'helper-offline': 0, 'remote-disabled': 0, 'no-traceroute': 0, 'failed': 0, 'timeout': 0 }
    for (const outcome of lastOutcomes.value)
      counts[outcome.status] += 1
    const parts: string[] = []
    if (counts.updated)
      parts.push(`${counts.updated} 台已更新`)
    if (counts['helper-offline'])
      parts.push(`${counts['helper-offline']} 台节点助手未连接`)
    if (counts['remote-disabled'])
      parts.push(`${counts['remote-disabled']} 台远程控制已关闭`)
    if (counts['no-traceroute'])
      parts.push(`${counts['no-traceroute']} 台未安装 traceroute`)
    if (counts.failed)
      parts.push(`${counts.failed} 台探测失败`)
    if (counts.timeout)
      parts.push(`${counts.timeout} 台超时未回`)
    return parts.join('，')
  })

  return { probing, lastError, lastOutcomes, lastSummary, pendingCount, probeNow }
}
