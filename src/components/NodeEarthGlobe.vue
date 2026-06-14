<script setup lang="ts">
import type { Arc, COBEOptions, Globe, Marker } from 'cobe'
import type { NodeData } from '@/stores/nodes'
import type { IpGeo } from '@/utils/ipGeoHelper'
import { Icon } from '@iconify/vue'
import {
  useDocumentVisibility,
  useElementSize,
  useElementVisibility,
  useRafFn,
} from '@vueuse/core'
import createGlobe from 'cobe'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getCoordByCode, getCountryCodeFromRegion } from '@/utils/geoHelper'
import { formatBytesPerSecondSplit } from '@/utils/helper'
import { lookupIpGeo } from '@/utils/ipGeoHelper'

const props = defineProps<{
  nodes?: NodeData[]
}>()
const appStore = useAppStore()
const nodesStore = useNodesStore()

const displayNodes = computed(() => props.nodes ?? nodesStore.nodes)

const containerRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef)

const documentVisibility = useDocumentVisibility()
const elementVisible = useElementVisibility(containerRef)
const shouldRender = computed(() => documentVisibility.value === 'visible' && elementVisible.value)
const shouldAutoRotate = computed(() => !appStore.stopEarth)

let globe: Globe | null = null
const INITIAL_THETA = 0.22
const MIN_THETA = -0.65
const MAX_THETA = 0.65
const CHINA_COORD = getCoordByCode('CN') ?? [35.8617, 104.1954]
const DEFAULT_PHI = normalizePhi(-Math.PI / 2 - CHINA_COORD[1] * Math.PI / 180)
let phi = DEFAULT_PHI
let targetPhi = phi
let theta = INITIAL_THETA
let targetTheta = INITIAL_THETA
let isPointerDown = false
let lastPointerX = 0
let lastPointerY = 0
let staticRedrawUntil = 0

// 访客坐标
const visitorCoord = ref<[number, number] | null>(null)

onMounted(async () => {
  try {
    const cached = localStorage.getItem('visitor_coord')
    if (cached) {
      visitorCoord.value = JSON.parse(cached)
    }
    else {
      const res = await fetch('https://ipapi.co/json/')
      const data = await res.json()
      if (data.latitude && data.longitude) {
        const coord: [number, number] = [data.latitude, data.longitude]
        visitorCoord.value = coord
        localStorage.setItem('visitor_coord', JSON.stringify(coord))
      }
    }
  }
  catch {
    // 静默失败，降级到 hub 连线
  }
})

// 各节点 IP → 城市坐标（异步解析后填充，驱动地球城市级定位）
const ipGeoMap = ref<Map<string, IpGeo>>(new Map())
const attemptedIps = new Set<string>()

async function resolveNodeCities(nodes: NodeData[]): Promise<void> {
  for (const node of nodes) {
    const ip = node.ipv4 || node.ipv6
    if (!ip || attemptedIps.has(ip) || ipGeoMap.value.has(ip))
      continue
    attemptedIps.add(ip)
    const geo = await lookupIpGeo(ip)
    if (geo) {
      // 重新赋值新 Map 以触发响应式更新
      const next = new Map(ipGeoMap.value)
      next.set(ip, geo)
      ipGeoMap.value = next
    }
  }
}

watch(displayNodes, (nodes) => {
  void resolveNodeCities(nodes)
}, { immediate: true })

function normalizePhi(value: number): number {
  const circle = Math.PI * 2
  let next = value % circle
  if (next <= -Math.PI)
    next += circle
  if (next > Math.PI)
    next -= circle
  return next
}

function clampTheta(value: number): number {
  return Math.min(Math.max(value, MIN_THETA), MAX_THETA)
}

function resetStoppedView() {
  phi = DEFAULT_PHI
  targetPhi = DEFAULT_PHI
  theta = INITIAL_THETA
  targetTheta = INITIAL_THETA
}

function triggerStaticRedrawWindow(duration = 1500) {
  if (typeof performance === 'undefined') {
    staticRedrawUntil = Date.now() + duration
    return
  }
  staticRedrawUntil = performance.now() + duration
}

function shouldKeepStaticRedraw(): boolean {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now()
  return now < staticRedrawUntil
}

function getCappedDpr(): number {
  if (typeof window === 'undefined')
    return 1.5
  const raw = window.devicePixelRatio || 1
  return Math.min(Math.max(raw, 1.5), 2)
}

interface RegionCluster {
  id: string
  code: string
  coord: [number, number]
  servers: number
  onlineServers: number
}

function clusterKey(c: RegionCluster) {
  return `${c.id}:${c.servers}:${c.onlineServers}`
}

// 计算单个节点的归属簇：优先用 IP 解析出的城市坐标，回退到国家中心点。
// id 用于 marker / 锚点唯一标识，code 为国家代码（用于国旗），coord 为标记坐标。
function nodeClusterInfo(node: NodeData): { id: string, code: string, coord: [number, number] } | null {
  const countryCode = getCountryCodeFromRegion(node.region)
  const ip = node.ipv4 || node.ipv6
  const geo = ip ? ipGeoMap.value.get(ip) : undefined

  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
    const code = (geo.countryCode || countryCode || '').toUpperCase()
    const citySlug = (geo.city || `${geo.lat.toFixed(2)},${geo.lng.toFixed(2)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return {
      id: `${(code || 'xx').toLowerCase()}-${citySlug || 'city'}`,
      code: code || (countryCode ?? ''),
      coord: [geo.lat, geo.lng],
    }
  }

  if (countryCode) {
    const coord = getCoordByCode(countryCode)
    if (coord)
      return { id: countryCode.toLowerCase(), code: countryCode, coord }
  }

  return null
}

const regionClusters = computed<RegionCluster[]>(() => {
  const map = new Map<string, RegionCluster>()
  for (const node of displayNodes.value) {
    const info = nodeClusterInfo(node)
    if (!info)
      continue
    let entry = map.get(info.id)
    if (!entry) {
      entry = { id: info.id, code: info.code, coord: info.coord, servers: 0, onlineServers: 0 }
      map.set(info.id, entry)
    }
    entry.servers += 1
    if (node.online)
      entry.onlineServers += 1
  }
  return Array.from(map.values()).sort((a, b) => b.servers - a.servers)
})

interface RegionRate {
  up: number
  down: number
}

const regionRates = computed<Map<string, RegionRate>>(() => {
  const map = new Map<string, RegionRate>()
  for (const node of displayNodes.value) {
    if (!node.online)
      continue
    const info = nodeClusterInfo(node)
    if (!info)
      continue
    let entry = map.get(info.id)
    if (!entry) {
      entry = { up: 0, down: 0 }
      map.set(info.id, entry)
    }
    entry.up += node.net_out || 0
    entry.down += node.net_in || 0
  }
  return map
})

function markerId(code: string): string {
  return `cdn-${code.toLowerCase()}`
}

const anchorRefs = shallowRef<ReadonlyMap<string, HTMLDivElement>>(new Map())

function getAnchorEl(code: string): HTMLDivElement | undefined {
  return anchorRefs.value.get(markerId(code))
}

let cachedContainerW = 0
let cachedContainerH = 0
function refreshContainerSizeCache() {
  cachedContainerW = containerWidth.value || canvasRef.value?.clientWidth || 320
  cachedContainerH = containerHeight.value || canvasRef.value?.clientHeight || cachedContainerW
}

const patchedAnchors = new WeakSet<HTMLElement>()

interface AnchorCtx {
  xPx: number
  yPx: number
}
const anchorCtxs = new WeakMap<HTMLDivElement, AnchorCtx>()
const dirtyAnchors = new Set<HTMLDivElement>()

function flushDirtyAnchors() {
  if (dirtyAnchors.size === 0)
    return
  for (const el of dirtyAnchors) {
    const ctx = anchorCtxs.get(el)
    if (ctx)
      el.style.transform = `translate3d(${ctx.xPx}px, ${ctx.yPx}px, 0)`
  }
  dirtyAnchors.clear()
}

function patchAnchorTransform(el: HTMLDivElement) {
  if (patchedAnchors.has(el))
    return
  refreshContainerSizeCache()
  const ctx: AnchorCtx = {
    xPx: ((Number.parseFloat(el.style.left) || 0) / 100) * cachedContainerW,
    yPx: ((Number.parseFloat(el.style.top) || 0) / 100) * cachedContainerH,
  }
  anchorCtxs.set(el, ctx)
  el.style.left = '0px'
  el.style.top = '0px'
  el.style.transform = `translate3d(${ctx.xPx}px, ${ctx.yPx}px, 0)`
  el.style.willChange = 'transform'
  try {
    Object.defineProperty(el.style, 'left', {
      configurable: true,
      enumerable: true,
      get() { return '0px' },
      set(v: string) {
        const next = ((Number.parseFloat(v) || 0) / 100) * cachedContainerW
        if (next === ctx.xPx)
          return
        ctx.xPx = next
        dirtyAnchors.add(el)
      },
    })
    Object.defineProperty(el.style, 'top', {
      configurable: true,
      enumerable: true,
      get() { return '0px' },
      set(v: string) {
        const next = ((Number.parseFloat(v) || 0) / 100) * cachedContainerH
        if (next === ctx.yPx)
          return
        ctx.yPx = next
        dirtyAnchors.add(el)
      },
    })
    patchedAnchors.add(el)
  }
  catch (err) {
    console.warn('[NodeEarthGlobe] anchor transform patch failed', err)
  }
}

function patchAllAnchors() {
  if (!canvasRef.value)
    return
  const wrapper = canvasRef.value.parentElement
  if (!wrapper)
    return
  const anchors = wrapper.querySelectorAll<HTMLDivElement>('div[style*="--cobe-"]')
  anchors.forEach(patchAnchorTransform)
}

const COBE_HOOK_FLAG = Symbol('cobeAppendHooked')
type HookableWrapper = HTMLElement & { [COBE_HOOK_FLAG]?: boolean }

function hookWrapperAppend() {
  if (!canvasRef.value)
    return
  const wrapper = canvasRef.value.parentElement as HookableWrapper | null
  if (!wrapper || wrapper[COBE_HOOK_FLAG])
    return
  wrapper[COBE_HOOK_FLAG] = true
  const origAppend = wrapper.append.bind(wrapper)
  wrapper.append = (...nodes: (Node | string)[]) => {
    const ret = origAppend(...nodes)
    for (const node of nodes) {
      if (node instanceof HTMLDivElement && node.style.cssText.includes('--cobe-'))
        patchAnchorTransform(node)
    }
    return ret
  }
}

function syncAnchorRefs() {
  if (!canvasRef.value) {
    anchorRefs.value = new Map()
    return
  }
  const wrapper = canvasRef.value.parentElement
  if (!wrapper) {
    anchorRefs.value = new Map()
    return
  }
  const next = new Map<string, HTMLDivElement>()
  for (const cluster of regionClusters.value) {
    const id = markerId(cluster.id)
    const el = wrapper.querySelector<HTMLDivElement>(`div[style*="--cobe-${id}"]`)
    if (el)
      next.set(id, el)
  }
  anchorRefs.value = next
}

const markers = computed<Marker[]>(() => {
  return regionClusters.value.map(cluster => ({
    id: markerId(cluster.id),
    location: cluster.coord,
    size: 0,
  }))
})

// 连线从访客IP出发，降级到节点最多的地区
const arcs = computed<Arc[]>(() => {
  const clusters = regionClusters.value
  if (clusters.length === 0)
    return []
  const fromCoord = visitorCoord.value ?? clusters[0]?.coord
  if (!fromCoord)
    return []
  return clusters.map(cluster => ({
    from: fromCoord,
    to: cluster.coord,
  }))
})

const themeColors = computed(() => {
  if (appStore.isDark) {
    return {
      dark: 1,
      mapBrightness: 8,
      baseColor: [0.95, 0.95, 0.98] as [number, number, number],
      markerColor: [0.3, 0.85, 1.0] as [number, number, number],
      glowColor: [0.75, 0.88, 0.98] as [number, number, number],
      arcColor: [0.50, 0.80, 0.95] as [number, number, number],
    }
  }
  return {
    dark: 0,
    mapBrightness: 10,
    baseColor: [0.98, 0.98, 0.99] as [number, number, number],
    markerColor: [0.05, 0.35, 0.90] as [number, number, number],
    glowColor: [0.80, 0.90, 1.0] as [number, number, number],
    arcColor: [0.45, 0.70, 0.90] as [number, number, number],
  }
})

function getRenderSize() {
  const width = containerWidth.value || canvasRef.value?.clientWidth || 320
  const height = containerHeight.value || canvasRef.value?.clientHeight || width
  return { width, height }
}

function buildInitialOptions(): COBEOptions {
  const colors = themeColors.value
  const { width, height } = getRenderSize()
  return {
    devicePixelRatio: 3,
    width,
    height,
    phi,
    theta,
    dark: colors.dark,
    diffuse: 0.5, // 从 2.2 降到 1.0，减少白色溢光
    mapSamples: 16000, // 适中采样：点阵更稀疏，旋转时摩尔纹更轻（过高采样会加剧像素干涉）
    mapBrightness: colors.mapBrightness,
    baseColor: colors.baseColor,
    markerColor: colors.markerColor,
    glowColor: colors.glowColor,
    markers: markers.value,
    arcs: arcs.value,
    arcColor: colors.arcColor,
    arcHeight: 0.4,
    arcWidth: 0.5,
    markerElevation: 0,

  }
}

function updateGlobeFrame(forceSyncAnchors = false) {
  if (!globe)
    return
  refreshContainerSizeCache()
  const { width, height } = getRenderSize()
  globe.update({ phi, theta, width, height })
  if (forceSyncAnchors)
    syncAnchorRefs()
  flushDirtyAnchors()
}

const ORIENTATION_IDLE_EPSILON = 1e-5
const { pause: pauseRaf, resume: resumeRaf } = useRafFn(
  () => {
    if (!globe)
      return
    const prevPhi = phi
    const prevTheta = theta
    if (!isPointerDown && shouldAutoRotate.value)
      targetPhi += 0.0014
    phi += (targetPhi - phi) * 1
    theta += (targetTheta - theta) * 1
    if (
      Math.abs(phi - prevPhi) < ORIENTATION_IDLE_EPSILON
      && Math.abs(theta - prevTheta) < ORIENTATION_IDLE_EPSILON
    ) {
      if (!shouldAutoRotate.value && shouldKeepStaticRedraw())
        updateGlobeFrame(true)
      return
    }
    updateGlobeFrame()
  },
  { immediate: false },
)

function startGlobe() {
  if (!canvasRef.value)
    return
  if (appStore.stopEarth) {
    resetStoppedView()
    triggerStaticRedrawWindow()
  }
  globe = createGlobe(canvasRef.value, buildInitialOptions())
  refreshContainerSizeCache()
  hookWrapperAppend()
  patchAllAnchors()
  syncAnchorRefs()
  requestAnimationFrame(() => {
    updateGlobeFrame(true)
  })
  if (documentVisibility.value === 'visible')
    resumeRaf()
}

async function stopGlobe() {
  pauseRaf()
  anchorRefs.value = new Map()
  await nextTick()
  globe?.destroy()
  globe = null
  if (canvasRef.value && containerRef.value) {
    const cobeWrapper = canvasRef.value.parentElement
    if (cobeWrapper && cobeWrapper !== containerRef.value) {
      containerRef.value.appendChild(canvasRef.value)
      cobeWrapper.remove()
    }
  }
}

async function rebuildGlobe() {
  await stopGlobe()
  startGlobe()
}

onMounted(() => {
  startGlobe()
})

onBeforeUnmount(() => {
  pauseRaf()
  globe?.destroy()
  globe = null
})

watch(() => appStore.isDark, async () => {
  await rebuildGlobe()
})

watch(
  [containerWidth, containerHeight],
  ([width, height]) => {
    if (!globe || width <= 0 || height <= 0)
      return
    if (!shouldAutoRotate.value)
      triggerStaticRedrawWindow(600)
    updateGlobeFrame(true)
  },
)

watch(
  () => appStore.stopEarth,
  (stopped) => {
    if (stopped)
      resetStoppedView()
    triggerStaticRedrawWindow()
    updateGlobeFrame(true)
  },
)

watch(
  () => regionClusters.value.map(clusterKey).join(','),
  () => {
    if (!globe)
      return
    refreshContainerSizeCache()
    globe.update({ markers: markers.value, arcs: arcs.value })
    syncAnchorRefs()
    if (!shouldAutoRotate.value)
      triggerStaticRedrawWindow(600)
    flushDirtyAnchors()
  },
)

// 访客坐标获取后重新推送 arcs
watch(visitorCoord, () => {
  if (!globe)
    return
  globe.update({ arcs: arcs.value })
  if (!shouldAutoRotate.value)
    triggerStaticRedrawWindow(600)
})

watch(shouldRender, (visible) => {
  if (!globe)
    return
  if (visible) {
    if (!shouldAutoRotate.value)
      triggerStaticRedrawWindow()
    resumeRaf()
  }
  else {
    pauseRaf()
  }
})

function onPointerDown(e: PointerEvent) {
  isPointerDown = true
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!isPointerDown)
    return
  const deltaX = e.clientX - lastPointerX
  const deltaY = e.clientY - lastPointerY
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  targetPhi += deltaX / 200
  targetTheta = clampTheta(targetTheta + deltaY / 300)
}
function onPointerUp(e: PointerEvent) {
  isPointerDown = false
  const target = e.currentTarget as HTMLElement
  if (target.hasPointerCapture(e.pointerId))
    target.releasePointerCapture(e.pointerId)
}

const totalServers = computed(() => displayNodes.value.length)
const onlineServers = computed(() => displayNodes.value.filter(node => node.online).length)
const offlineServers = computed(() => totalServers.value - onlineServers.value)

function rateFor(id: string): RegionRate {
  return regionRates.value.get(id) ?? { up: 0, down: 0 }
}

function formatRate(bytesPerSec: number): string {
  const { value, unit } = formatBytesPerSecondSplit(bytesPerSec, appStore.byteDecimals)
  return `${value} ${unit}`
}
</script>

<template>
  <div ref="containerRef" class="relative aspect-square w-full max-w-md mx-auto -translate-y-6 md:-translate-y-12">
    <canvas
      ref="canvasRef"
      class="earth-globe-canvas absolute inset-0 w-full h-full select-none touch-none cursor-grab active:cursor-grabbing"
      @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    />

    <template v-for="cluster in regionClusters" :key="cluster.id">
      <Teleport :to="getAnchorEl(cluster.id) ?? containerRef!" :disabled="!getAnchorEl(cluster.id)">
        <div
          class="absolute -top-7.5 left-0 transition-[opacity,filter] duration-500 rounded backdrop-blur-[2px]"
          :style="{
            opacity: `var(--cobe-visible-${markerId(cluster.id)}, 0)`,
            filter: `blur(calc((1 - var(--cobe-visible-${markerId(cluster.id)}, 0)) * 20px))`,
          }"
        >
          <img
            :src="`/images/flags/${cluster.code}.svg`" :alt="cluster.code"
            class="size-4 block absolute -bottom-2 -left-2 z-1"
          >
          <div class="relative z-2 bg-background/60 rounded py-0.5 px-1 text-xs zoom-80 items-start justify-center text-nowrap">
            <div class="text-green-600 flex flex-row items-center gap-0.5">
              <Icon icon="tabler:chevron-up" width="12" height="12" /> {{ formatRate(rateFor(cluster.id).up) }}
            </div>
            <div class="text-blue-600 flex flex-row items-center gap-0.5">
              <Icon icon="tabler:chevron-down" width="12" height="12" /> {{ formatRate(rateFor(cluster.id).down) }}
            </div>
          </div>
        </div>
      </Teleport>
    </template>

    <div
      v-if="totalServers > 0"
      class="absolute top-6 md:top-12 left-0 text-[10px] text-muted-foreground pointer-events-none flex gap-2 items-center backdrop-blur-lg bg-background/60 rounded px-2 py-0.5"
    >
      <div v-if="onlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-green-600 animate-pulse" />
        <span class="text-green-600">{{ onlineServers }}</span>
      </div>
      <div v-if="offlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-yellow-600 animate-pulse" />
        <span class="text-yellow-600">{{ offlineServers }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.earth-globe-canvas {
  contain: layout paint;
  filter: blur(0.5px); /* 轻微模糊柔化点阵，进一步抑制旋转时的摩尔纹 */
}
</style>
