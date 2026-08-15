import type { PersonalWallpaperRecord } from '@/services/wallpaper.service'
import type { PersonalWallpaperEffect } from '@/utils/wallpaper'
import { computed, readonly, ref, shallowRef } from 'vue'
import { parsePersonalWallpaperEffect } from '@/utils/wallpaper'

const WALLPAPER_EFFECT_KEY = 'transit:wallpaper-effect:v1'

function readStoredEffect(): PersonalWallpaperEffect {
  if (typeof localStorage === 'undefined')
    return 'glass'
  try {
    return parsePersonalWallpaperEffect(localStorage.getItem(WALLPAPER_EFFECT_KEY))
  }
  catch {
    return 'glass'
  }
}

const record = shallowRef<PersonalWallpaperRecord | null>(null)
const source = ref('')
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const busy = ref(false)
const errorMessage = ref('')
const effect = ref<PersonalWallpaperEffect>(readStoredEffect())

let initializationPromise: Promise<void> | null = null

function replaceRecord(nextRecord: PersonalWallpaperRecord | null): void {
  const nextSource = nextRecord ? URL.createObjectURL(nextRecord.blob) : ''
  const previousSource = source.value
  record.value = nextRecord
  source.value = nextSource
  if (previousSource)
    URL.revokeObjectURL(previousSource)
}

async function initialize(): Promise<void> {
  if (status.value === 'ready')
    return
  if (initializationPromise)
    return initializationPromise

  status.value = 'loading'
  errorMessage.value = ''
  initializationPromise = (async () => {
    try {
      const { loadPersonalWallpaper } = await import('@/services/wallpaper.service')
      replaceRecord(await loadPersonalWallpaper())
      status.value = 'ready'
    }
    catch (error) {
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '无法读取本地壁纸。'
    }
    finally {
      initializationPromise = null
    }
  })()
  return initializationPromise
}

async function upload(file: File): Promise<void> {
  if (busy.value)
    throw new Error('正在处理壁纸，请稍候。')

  busy.value = true
  errorMessage.value = ''
  try {
    await initialize()
    const { savePersonalWallpaper } = await import('@/services/wallpaper.service')
    replaceRecord(await savePersonalWallpaper(file))
    status.value = 'ready'
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '壁纸保存失败。'
    throw error
  }
  finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (busy.value)
    throw new Error('正在处理壁纸，请稍候。')

  busy.value = true
  errorMessage.value = ''
  try {
    await initialize()
    const { removePersonalWallpaper } = await import('@/services/wallpaper.service')
    await removePersonalWallpaper()
    replaceRecord(null)
    status.value = 'ready'
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '壁纸移除失败。'
    throw error
  }
  finally {
    busy.value = false
  }
}

function setEffect(nextEffect: PersonalWallpaperEffect): void {
  effect.value = parsePersonalWallpaperEffect(nextEffect)
  try {
    localStorage.setItem(WALLPAPER_EFFECT_KEY, effect.value)
  }
  catch {
    // The visual effect still applies for the current page when storage is unavailable.
  }
}

const hasWallpaper = computed(() => Boolean(record.value && source.value))

export function usePersonalWallpaper() {
  return {
    record: readonly(record),
    source: readonly(source),
    status: readonly(status),
    busy: readonly(busy),
    errorMessage: readonly(errorMessage),
    effect: readonly(effect),
    hasWallpaper,
    initialize,
    upload,
    remove,
    setEffect,
  }
}
