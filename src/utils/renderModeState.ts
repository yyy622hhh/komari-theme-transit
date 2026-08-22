import type { EarthRenderer } from '@/stores/app.types'
import { ref } from 'vue'
import { detectWebglSupport, isLowPowerDevice } from '@/utils/deviceCapability'

export interface EarthRenderModeState {
  /** 主题设置里选的渲染方式。 */
  configured: EarthRenderer
  /** 实际用的渲染方式——设备不支持或运行时初始化失败时会比 configured 更轻量。 */
  active: EarthRenderer
  /** 为什么两者不一致；两者一致时为 null。 */
  reason: string | null
}

/**
 * 地球实际渲染模式与图表预加载状态的进程内单例。`NodeEarthGlobe.vue` 写，
 * `GlobalDiagnosticsPanel.vue` 读——两者不在同一棵组件树里（地球只在经典布局下
 * 挂载），用 Pinia store 纯属大材小用，一个模块级 ref 就够。地球从未挂载过时
 * （比如站点用的是默认 Transit 首页布局）保持 null，不编造一个假状态。
 */
export const earthRenderModeState = ref<EarthRenderModeState | null>(null)

export const chartsPreloadState = ref<'idle' | 'loading' | 'done' | 'failed'>('idle')

export function setEarthRenderMode(state: EarthRenderModeState | null): void {
  earthRenderModeState.value = state
}

/**
 * 只根据设备能力和主题配置决定档位，不含运行时初始化失败。配置已经是平铺时
 * 不探 WebGL，避免给本来不用 3D 的布局白占一个 context。
 */
export function resolveStaticEarthRenderer(configured: EarthRenderer): {
  active: EarthRenderer
  reason: string | null
} {
  if (configured === 'tiled')
    return { active: 'tiled', reason: null }

  const support = detectWebglSupport()
  if (configured === 'cobe') {
    return support.webgl1
      ? { active: 'cobe', reason: null }
      : { active: 'tiled', reason: 'WebGL 不可用，已自动切换为平铺地图。' }
  }

  if (!support.webgl2) {
    return support.webgl1
      ? { active: 'cobe', reason: '当前设备不支持 WebGL2，已自动切换为点阵地球。' }
      : { active: 'tiled', reason: 'WebGL 不可用，已自动切换为平铺地图。' }
  }
  if (isLowPowerDevice())
    return { active: 'cobe', reason: '检测到低性能或触屏设备，已自动切换为点阵地球以保证流畅度。' }
  return { active: 'realistic', reason: null }
}
