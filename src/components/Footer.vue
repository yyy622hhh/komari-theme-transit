<script setup lang="ts">
import type { VersionInfo } from '@/utils/api'
import { computed, onMounted, ref } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { loadServerVersion } from '@/services/version.service'

const buildVersion = __BUILD_VERSION__
const buildGitHash = __BUILD_GIT_HASH__

const serverVersion = ref<VersionInfo | null>(null)

onMounted(async () => {
  serverVersion.value = await loadServerVersion()
})

const formattedServerVersion = computed(() => serverVersion.value?.version ?? '')
</script>

<template>
  <footer class="w-full max-w-[1280px] mx-auto p-4">
    <div class="flex w-full flex-row justify-between gap-4 text-xs text-muted-foreground">
      <div class="flex gap-1 items-center">
        Powered by
        <DataTooltip
          as="span"
          placement="top"
          :content="formattedServerVersion"
        >
          <a
            href="https://github.com/komari-monitor/komari" target="_blank" rel="noopener noreferrer"
            class="transition-opacity hover:opacity-80"
          >
            <span class="font-medium text-foreground">Komari Monitor</span>
          </a>
        </DataTooltip>
      </div>
      <div class="flex flex-wrap gap-1 items-center justify-end text-right">
        Theme by
        <DataTooltip
          as="span"
          placement="top"
          :content="`v${buildVersion}\n${buildGitHash}`"
        >
          <a
            href="https://github.com/yyy622hhh/komari-theme-transit" target="_blank" rel="noopener noreferrer"
            class="transition-opacity hover:opacity-80"
          >
            <span class="font-medium text-foreground">Transit</span>
          </a>
        </DataTooltip>
      </div>
    </div>
  </footer>
</template>
