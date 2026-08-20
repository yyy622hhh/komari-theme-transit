import type { PublicSettings } from '@/utils/api'
import { ref } from 'vue'

export function usePublicSettingsState() {
  const publicSettings = ref<PublicSettings>()
  const publicSettingsEpoch = ref(0)

  function applyPublicSettings(settings: PublicSettings): void {
    const current = publicSettings.value
    if (!current || current.theme === settings.theme) {
      publicSettings.value = settings
      publicSettingsEpoch.value += 1
    }
  }

  function applyFetchedPublicSettings(settings: PublicSettings, readEpoch: number): void {
    if (readEpoch !== publicSettingsEpoch.value)
      return
    applyPublicSettings(settings)
  }

  return { publicSettings, publicSettingsEpoch, applyPublicSettings, applyFetchedPublicSettings }
}
