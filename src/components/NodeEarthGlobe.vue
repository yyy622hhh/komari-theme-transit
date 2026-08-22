<script setup lang="ts">
import type { EarthRenderer } from '@/stores/app.types'
import type { NodeData } from '@/stores/nodes'
import { computed, defineAsyncComponent, ref, useAttrs, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { detectWebglSupport, isLowPowerDevice } from '@/utils/deviceCapability'
import { setEarthRenderMode } from '@/utils/renderModeState'

const props = defineProps<{
  nodes?: NodeData[]
}>()

const attrs = useAttrs()
const appStore = useAppStore()

const NodeEarthCobeGlobe = defineAsyncComponent(() => import('@/components/NodeEarthCobeGlobe.vue'))
const NodeEarthRealisticGlobe = defineAsyncComponent(() => import('@/components/NodeEarthRealisticGlobe.vue'))
const NodeEarthTiledMap = defineAsyncComponent(() => import('@/components/NodeEarthTiledMap.vue'))

/** 0=平铺地图（纯 SVG，总能用），1=点阵（cobe，需 WebGL1），2=写实（globe.gl，需 WebGL2）。 */
type Tier = 0 | 1 | 2
const RENDERER_BY_TIER: Record<Tier, EarthRenderer> = { 0: 'tiled', 1: 'cobe', 2: 'realistic' }
const TIER_BY_RENDERER: Record<EarthRenderer, Tier> = { tiled: 0, cobe: 1, realistic: 2 }

const support = detectWebglSupport()
const lowPower = isLowPowerDevice()

/**
 * 静态探测能给到的最高档位——只算一次，不随运行时失败变化。写实需要 WebGL2；
 * 不支持就退到点阵；点阵还需要 WebGL1，也不支持就只能平铺。低性能/触屏设备
 * 即使 WebGL2 可用也直接从写实降到点阵，避免把这类设备的主线程耗在着色器和
 * 纹理加载上。
 */
const staticCapTier = computed<Tier>(() => {
  const configuredTier = TIER_BY_RENDERER[appStore.earthRenderer]
  if (configuredTier === 2) {
    if (!support.webgl2)
      return support.webgl1 ? 1 : 0
    if (lowPower)
      return 1
    return 2
  }
  if (configuredTier === 1)
    return support.webgl1 ? 1 : 0
  return 0
})

/**
 * 运行时降档上限：挂载的渲染器自己报告初始化失败（静态探测漏判、驱动/内存这类
 * 探测不到的问题）后在这里封顶，不会因为重新求值又弹回失败过的那一档。
 */
const runtimeCapTier = ref<Tier>(2)

const activeTier = computed<Tier>(() => Math.min(staticCapTier.value, runtimeCapTier.value) as Tier)

const reason = computed<string | null>(() => {
  if (runtimeCapTier.value < staticCapTier.value) {
    return activeTier.value === 1
      ? '写实地球初始化失败，已自动切换为点阵地球。'
      : '地球渲染初始化失败，已自动切换为平铺地图。'
  }
  const configuredTier = TIER_BY_RENDERER[appStore.earthRenderer]
  if (activeTier.value === configuredTier)
    return null
  if (activeTier.value === 0)
    return 'WebGL 不可用，已自动切换为平铺地图。'
  if (configuredTier === 2 && !support.webgl2)
    return '当前设备不支持 WebGL2，已自动切换为点阵地球。'
  return '检测到低性能或触屏设备，已自动切换为点阵地球以保证流畅度。'
})

watch([activeTier, reason], ([tier, currentReason]) => {
  setEarthRenderMode({ configured: appStore.earthRenderer, active: RENDERER_BY_TIER[tier], reason: currentReason })
}, { immediate: true })

function handleUnavailable(): void {
  runtimeCapTier.value = Math.min(runtimeCapTier.value, activeTier.value - 1) as Tier
}

const earthComponent = computed(() => ({
  realistic: NodeEarthRealisticGlobe,
  cobe: NodeEarthCobeGlobe,
  tiled: NodeEarthTiledMap,
}[RENDERER_BY_TIER[activeTier.value]]))
</script>

<template>
  <component :is="earthComponent" v-bind="attrs" :nodes="props.nodes" @unavailable="handleUnavailable" />
</template>
