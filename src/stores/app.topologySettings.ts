import type { ComputedRef } from 'vue'
import type { ThemeSettings } from '@/utils/themeSettings'
import { computed } from 'vue'
import { readBooleanSetting, readStringSetting } from '@/stores/app.settings'

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
  routeProbeAutoEnabled: ComputedRef<boolean>
  topologyConfig: ComputedRef<string>
  topologyRoute: ComputedRef<string>
  topologyMetrics: ComputedRef<string>
}

export function createTopologySettings(themeSettings: ComputedRef<ThemeSettings>): TopologySettings {
  return {
    topologyEnabled: computed(() => readBooleanSetting(themeSettings.value, 'topologyEnabled', true)),

    /**
     * 两个默认开启、且无人值守就会写后端的开关，都给站长留了显式出口。
     *
     * 自愈会建删 Ping 任务并改写拓扑绑定；回程检测更重一档——它通过 Komari 的
     * `admin:exec` 在运营者的节点上执行 traceroute。下发的命令是编译期常量，
     * 完整的触发条件与克制机制见 `composables/useRouteProbe.ts`。
     * 关掉任一个都不影响对应的手动操作。
     */
    topologyAutoRepairEnabled: computed(() => readBooleanSetting(themeSettings.value, 'topologyAutoRepairEnabled', true)),
    routeProbeAutoEnabled: computed(() => readBooleanSetting(themeSettings.value, 'routeProbeAutoEnabled', true)),

    /** JSON 格式的拓扑配置，取代下面两条遗留字符串；读取一律走 readTopologyRoutes()。 */
    topologyConfig: computed(() => readStringSetting(themeSettings.value, 'topologyConfig')),
    topologyRoute: computed(() => readStringSetting(themeSettings.value, 'topologyRoute')),
    topologyMetrics: computed(() => readStringSetting(themeSettings.value, 'topologyMetrics')),
  }
}
