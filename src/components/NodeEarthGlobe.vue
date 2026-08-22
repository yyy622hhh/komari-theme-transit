<script setup lang="ts">
import type { EarthRenderer } from '@/stores/app.types'
import type { NodeData } from '@/stores/nodes'
import { computed, defineAsyncComponent, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { resolveStaticEarthRenderer, setEarthRenderMode } from '@/utils/renderModeState'

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

const staticResolved = computed(() => resolveStaticEarthRenderer(appStore.earthRenderer))
const staticCapTier = computed<Tier>(() => TIER_BY_RENDERER[staticResolved.value.active])

/**
 * 运行时降档上限：挂载的渲染器自己报告初始化失败（静态探测漏判、驱动/内存这类
 * 探测不到的问题）后在这里封顶，不会因为重新求值又弹回失败过的那一档。
 * 操作者改了主题里的渲染方式后清掉，允许再试更高档。
 */
const runtimeCapTier = ref<Tier>(2)

watch(() => appStore.earthRenderer, () => {
  runtimeCapTier.value = 2
})

const activeTier = computed<Tier>(() => Math.min(staticCapTier.value, runtimeCapTier.value) as Tier)

const reason = computed<string | null>(() => {
  if (runtimeCapTier.value < staticCapTier.value) {
    return activeTier.value === 1
      ? '写实地球初始化失败，已自动切换为点阵地球。'
      : '地球渲染初始化失败，已自动切换为平铺地图。'
  }
  return staticResolved.value.reason
})

watch([activeTier, reason], ([tier, currentReason]) => {
  setEarthRenderMode({ configured: appStore.earthRenderer, active: RENDERER_BY_TIER[tier], reason: currentReason })
}, { immediate: true })

onBeforeUnmount(() => {
  setEarthRenderMode(null)
})

function handleUnavailable(): void {
  runtimeCapTier.value = Math.max(0, Math.min(runtimeCapTier.value, activeTier.value - 1)) as Tier
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
