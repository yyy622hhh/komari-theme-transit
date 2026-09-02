import type { ComputedRef } from 'vue'
import type { RouteProbeResults } from '@/utils/routeProbeResults'
import type { ThemeSettings } from '@/utils/themeSettings'
import { computed } from 'vue'
import { readBooleanSetting, readStringSetting } from '@/stores/app.settings'
import { normalizeRouteProbeResults, ROUTE_PROBE_RESULTS_SETTING } from '@/utils/routeProbeResults'

/**
 * 拓扑与回程相关的托管设置读取。
 *
 * 从 `stores/app.ts` 拆出来的原因是那个文件已经顶到 600 行的源文件上限，而这一
 * 簇设置本身也自成一题：两个「无人值守写后端」的开关，加上一份新旧三种格式并存
 * 的拓扑配置。拆出来不改变 store 的对外形状——`app.ts` 原样解构并继续导出同名字段。
 */
export interface TopologySettings {
  topologyEnabled: ComputedRef<boolean>
  topologyAutoRepairEnabled: ComputedRef<boolean>
  routeProbeEnabled: ComputedRef<boolean>
  routeProbeResults: ComputedRef<RouteProbeResults>
  topologyConfig: ComputedRef<string>
  topologyRoute: ComputedRef<string>
  topologyMetrics: ComputedRef<string>
}

export function createTopologySettings(themeSettings: ComputedRef<ThemeSettings>): TopologySettings {
  return {
    topologyEnabled: computed(() => readBooleanSetting(themeSettings.value, 'topologyEnabled', true)),

    /** 自动修复仍默认开启，但可以由站长完整关闭无人值守写入。 */
    topologyAutoRepairEnabled: computed(() => readBooleanSetting(themeSettings.value, 'topologyAutoRepairEnabled', true)),

    /**
     * 回程采集是可选能力，默认不在别人的节点上做任何探测。这里刻意不继承早期
     * `routeProbeAutoEnabled` 的默认开启状态：升级后的站点也必须由站长明确打开新
     * 总开关。它同时控制自动轮询和首页手动入口；已有 `transit-route:` 标签的展示
     * 不受影响。
     */
    routeProbeEnabled: computed(() => readBooleanSetting(themeSettings.value, 'routeProbeEnabled', false)),

    /**
     * Return-route evidence is public monitoring data, but it is not a user tag.
     * Keeping it in theme settings prevents Komari's admin billing column from
     * rendering the internal `transit-route:` payload as a badge.
     */
    routeProbeResults: computed(() => normalizeRouteProbeResults(
      themeSettings.value[ROUTE_PROBE_RESULTS_SETTING],
    )),

    /** JSON 格式的拓扑配置，取代下面两条遗留字符串；读取一律走 readTopologyRoutes()。 */
    topologyConfig: computed(() => readStringSetting(themeSettings.value, 'topologyConfig')),
    topologyRoute: computed(() => readStringSetting(themeSettings.value, 'topologyRoute')),
    topologyMetrics: computed(() => readStringSetting(themeSettings.value, 'topologyMetrics')),
  }
}
