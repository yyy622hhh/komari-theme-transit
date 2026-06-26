<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

const isLoaded = ref(false)
const hasError = ref(false)

const showBackground = computed(() => appStore.backgroundEnabled)
const currentUrl = computed(() => appStore.currentBackgroundUrl)
const backgroundType = computed(() => appStore.backgroundType)
const hasCustomBackground = computed(() => showBackground.value && !!currentUrl.value)
const showBackgroundOverlay = computed(() => appStore.backgroundOverlay > 0)

const backgroundStyle = computed(() => {
  const blur = appStore.backgroundBlur
  return {
    filter: blur > 0 ? `blur(${blur}px)` : 'none',
    opacity: appStore.backgroundType === 'video' && !isLoaded.value ? 0 : 1,
  }
})

const backgroundContainerStyle = computed(() => {
  const overlay = appStore.backgroundOverlay
  if (overlay >= 0)
    return {}

  return { opacity: 1 - Math.abs(overlay) / 100 }
})

const overlayStyle = computed(() => {
  const overlay = appStore.backgroundOverlay
  if (overlay <= 0)
    return {}

  return { backgroundColor: `rgba(0, 0, 0, ${overlay / 100})` }
})

const showLoadedBackground = computed(() =>
  hasCustomBackground.value && isLoaded.value && !hasError.value,
)

const showMediaBackground = computed(() =>
  hasCustomBackground.value && !hasError.value && (backgroundType.value === 'video' || showLoadedBackground.value),
)

const showDefaultBackground = computed(() => !hasCustomBackground.value)

const showLoadingBackground = computed(() =>
  hasCustomBackground.value && !isLoaded.value && !hasError.value,
)

const showFallbackBackground = computed(() =>
  hasCustomBackground.value && hasError.value,
)

let imageLoader: HTMLImageElement | null = null

function clearImageLoader() {
  if (imageLoader) {
    imageLoader.onload = null
    imageLoader.onerror = null
    imageLoader = null
  }
}

function loadImage(url: string) {
  isLoaded.value = false
  hasError.value = false

  clearImageLoader()

  imageLoader = new Image()
  imageLoader.onload = () => {
    isLoaded.value = true
    hasError.value = false
  }
  imageLoader.onerror = () => {
    isLoaded.value = false
    hasError.value = true
  }
  imageLoader.src = url
}

const videoRef = ref<HTMLVideoElement | null>(null)

function handleVideoLoaded() {
  isLoaded.value = true
  hasError.value = false
}
function handleVideoError() {
  isLoaded.value = false
  hasError.value = true
}

watch([currentUrl, backgroundType], ([url, type]) => {
  if (url && type === 'image') {
    loadImage(url)
  }
  else if (url && type === 'video') {
    clearImageLoader()
    isLoaded.value = false
    hasError.value = false
  }
  else {
    clearImageLoader()
    isLoaded.value = false
    hasError.value = false
  }
}, { immediate: true })

onUnmounted(() => {
  clearImageLoader()
})
</script>

<template>
  <div class="background-container" :style="backgroundContainerStyle">
    <Transition name="fade">
      <div v-if="showDefaultBackground" class="default-background">
        <div class="default-background__mesh" />
        <div class="default-background__glow default-background__glow--cyan" />
        <div class="default-background__glow default-background__glow--violet" />
        <div class="default-background__glow default-background__glow--mint" />
        <div class="default-background__grid" />
      </div>
    </Transition>
    <Transition name="fade">
      <div v-if="showLoadingBackground" class="background-loading" />
    </Transition>
    <Transition name="fade">
      <div v-if="showFallbackBackground" class="background-loading" />
    </Transition>
    <Transition name="fade">
      <div v-if="showMediaBackground" class="background-media" :style="backgroundStyle">
        <div
          v-if="backgroundType === 'image'"
          class="background-image"
          :style="{ backgroundImage: `url(${currentUrl})` }"
        />
        <video
          v-else-if="backgroundType === 'video'"
          ref="videoRef"
          class="background-video"
          :src="currentUrl ?? undefined"
          autoplay
          loop
          muted
          preload="auto"
          playsinline
          @loadeddata="handleVideoLoaded"
          @canplay="handleVideoLoaded"
          @error="handleVideoError"
        />
      </div>
    </Transition>
    <div v-if="showBackgroundOverlay" class="background-overlay" :style="overlayStyle" />
  </div>
</template>

<style scoped>
.background-container {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
}

.default-background {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 12% 18%, rgb(125 211 252 / 0.32), transparent 30%),
    radial-gradient(circle at 78% 10%, rgb(196 181 253 / 0.28), transparent 28%),
    linear-gradient(135deg, #f8fbff 0%, #eef7ff 38%, #f6f0ff 68%, #eefdf8 100%);
}

.dark .default-background {
  background:
    radial-gradient(circle at 18% 16%, rgb(34 211 238 / 0.18), transparent 32%),
    radial-gradient(circle at 82% 12%, rgb(168 85 247 / 0.2), transparent 30%),
    linear-gradient(135deg, #08111f 0%, #101827 38%, #1a1430 68%, #061c1a 100%);
}

.default-background__mesh,
.default-background__grid,
.default-background__glow {
  position: absolute;
  pointer-events: none;
}

.default-background__mesh {
  inset: -18%;
  background:
    conic-gradient(from 130deg at 28% 32%, transparent 0 20%, rgb(20 184 166 / 0.22) 32%, transparent 45% 100%),
    conic-gradient(from 320deg at 74% 62%, transparent 0 18%, rgb(59 130 246 / 0.18) 30%, transparent 48% 100%),
    linear-gradient(115deg, transparent 0 40%, rgb(255 255 255 / 0.58) 48%, transparent 58% 100%);
  filter: blur(28px);
  transform: rotate(-8deg);
}

.dark .default-background__mesh {
  background:
    conic-gradient(from 130deg at 28% 32%, transparent 0 20%, rgb(45 212 191 / 0.16) 32%, transparent 45% 100%),
    conic-gradient(from 320deg at 74% 62%, transparent 0 18%, rgb(96 165 250 / 0.14) 30%, transparent 48% 100%),
    linear-gradient(115deg, transparent 0 40%, rgb(255 255 255 / 0.08) 48%, transparent 58% 100%);
}

.default-background__glow {
  border-radius: 9999px;
  filter: blur(10px);
  opacity: 0.7;
}

.default-background__glow--cyan {
  top: 10%;
  left: 4%;
  width: 38rem;
  height: 38rem;
  background: rgb(56 189 248 / 0.22);
}

.default-background__glow--violet {
  right: -8%;
  top: -10%;
  width: 34rem;
  height: 34rem;
  background: rgb(167 139 250 / 0.24);
}

.default-background__glow--mint {
  right: 16%;
  bottom: -18%;
  width: 46rem;
  height: 46rem;
  background: rgb(52 211 153 / 0.16);
}

.dark .default-background__glow {
  opacity: 0.55;
}

.default-background__grid {
  inset: 0;
  background-image:
    linear-gradient(rgb(15 23 42 / 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgb(15 23 42 / 0.055) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(circle at 50% 28%, black, transparent 72%);
}

.dark .default-background__grid {
  background-image:
    linear-gradient(rgb(255 255 255 / 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 0.06) 1px, transparent 1px);
}

.background-loading {
  position: absolute;
  inset: 0;
  background-color: var(--background);
}

.background-media {
  position: absolute;
  inset: 0;
  transition: opacity 0.8s ease;
}

.background-image {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

.background-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.background-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.8s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
