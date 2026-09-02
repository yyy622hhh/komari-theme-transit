<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed, defineAsyncComponent, inject, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useVisitorAudit } from '@/composables/useVisitorAudit'
import { KOMARI_ADMIN_SERVERS_PATH } from '@/constants'
import { useAppStore } from '@/stores/app'

const VisitorInfo = defineAsyncComponent(() => import('@/components/VisitorInfo.vue'))
const WallpaperManagerDialog = defineAsyncComponent(() => import('@/components/WallpaperManagerDialog.vue'))

const router = useRouter()
const appStore = useAppStore()
const { record: recordVisitorEvent } = useVisitorAudit()

const isScrolled = inject<ReturnType<typeof ref<boolean>>>('isScrolled', ref(false))

const siteFavicon = ref('/favicon.ico')
const wallpaperDialogOpen = ref(false)

const actionButtons = computed(() => {
  const themeTitleMap = {
    auto: appStore.managedThemeMode === 'beijing'
      ? appStore.isBeijingDaytime ? '自动主题：北京时间日间' : '自动主题：北京时间夜间'
      : appStore.managedThemeMode === 'light' ? '自动主题：后台浅色' : '自动主题：后台深色',
    light: '浅色主题',
    dark: '深色主题',
  } as const

  const themeIconMap = {
    auto: appStore.isDark ? 'icon-park-outline:moon' : 'icon-park-outline:sun-one',
    light: 'icon-park-outline:sun-one',
    dark: 'icon-park-outline:moon',
  } as const

  const buttons: Array<{ title: string, icon: string, action: string, href?: string, pressed?: boolean }> = []

  if (router.currentRoute.value.name === 'home' && appStore.homeToolsEnabled) {
    buttons.push({
      title: appStore.homeAdvancedToolsVisible ? '收起首页工具' : '显示首页工具',
      icon: 'tabler:tools',
      action: 'toggleHomeTools',
      pressed: appStore.homeAdvancedToolsVisible,
    })
  }

  buttons.push({
    title: '壁纸与背景效果',
    icon: 'tabler:photo-cog',
    action: 'openWallpaper',
  })

  buttons.push({
    title: `${themeTitleMap[appStore.themeMode]}（点击切换）`,
    icon: themeIconMap[appStore.themeMode],
    action: 'toggleTheme',
  })

  if (!appStore.loading && (appStore.privateFeaturesAllowed || !appStore.hideAdminEntryWhenLoggedOut)) {
    buttons.push({
      title: '后台管理',
      icon: 'icon-park-outline:setting',
      action: 'jumpToSetting',
      href: KOMARI_ADMIN_SERVERS_PATH,
    })
  }
  return buttons
})

function handleButtonClick(action: string) {
  switch (action) {
    case 'toggleTheme':
      appStore.updateThemeMode()
      void recordVisitorEvent({
        event: 'theme_mode_change',
        path: router.currentRoute.value.path,
        route: String(router.currentRoute.value.name ?? ''),
        target: appStore.themeMode,
      })
      break
    case 'openWallpaper':
      wallpaperDialogOpen.value = true
      break
    case 'toggleHomeTools':
      appStore.homeAdvancedToolsVisible = !appStore.homeAdvancedToolsVisible
      break
    case 'jumpToSetting':
      void recordVisitorEvent({
        event: 'admin_entry_click',
        path: router.currentRoute.value.path,
        route: String(router.currentRoute.value.name ?? ''),
      })
      break
  }
}

const sitename = computed(() => appStore.publicSettings?.sitename || 'Komari Monitor')
</script>

<template>
  <!-- 访客 IP 组件，全局悬浮 -->
  <VisitorInfo v-if="!appStore.loading && appStore.visitorInfoEnabled" />
  <WallpaperManagerDialog v-if="wallpaperDialogOpen" v-model:open="wallpaperDialogOpen" />

  <header
    class="site-header transition-all duration-200 top-0 sticky z-10 border-b border-transparent"
    :class="isScrolled ? '!border-slate-500/10 backdrop-blur-lg' : 'bg-transparent'"
  >
    <div
      class="mx-auto h-14 px-4 flex-between"
      :class="appStore.opsDashboardEnabled ? 'max-w-[1712px]' : 'max-w-[1280px]'"
    >
      <RouterLink to="/" class="flex min-w-0 flex-1 items-center gap-3" aria-label="返回首页">
        <Avatar class="size-8 shrink-0">
          <AvatarImage :src="siteFavicon" :alt="sitename" />
          <AvatarFallback>{{ sitename.slice(0, 1) }}</AvatarFallback>
        </Avatar>
        <h3 class="m-0 truncate text-lg font-semibold">
          {{ sitename }}
        </h3>
      </RouterLink>
      <div class="ml-2 flex shrink-0 items-center gap-1 sm:gap-2">
        <Button
          v-for="button in actionButtons"
          :key="button.action"
          :as="button.href ? 'a' : 'button'"
          :href="button.href"
          variant="ghost"
          size="icon-sm"
          :title="button.title"
          :aria-label="button.title"
          :aria-pressed="button.pressed"
          :class="button.pressed && 'bg-background/70 text-selection'"
          @click="handleButtonClick(button.action)"
        >
          <Icon :icon="button.icon" :width="18" :height="18" />
        </Button>
      </div>
    </div>
  </header>
</template>
