import { validateWallpaperDimensions, validateWallpaperFileMetadata } from '@/utils/wallpaper'

const WALLPAPER_DATABASE = 'transit-personalization'
const WALLPAPER_STORE = 'wallpapers'
const WALLPAPER_KEY = 'active'
const WALLPAPER_DATABASE_VERSION = 1

export interface PersonalWallpaperRecord {
  id: typeof WALLPAPER_KEY
  blob: Blob
  name: string
  type: string
  size: number
  width: number
  height: number
  updatedAt: number
}

function openWallpaperDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('当前浏览器不支持本地壁纸存储。'))

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WALLPAPER_DATABASE, WALLPAPER_DATABASE_VERSION)
    let settled = false

    const fail = (message: string) => {
      if (settled)
        return
      settled = true
      reject(new Error(message))
    }

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WALLPAPER_STORE))
        request.result.createObjectStore(WALLPAPER_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => fail('无法打开本地壁纸存储。')
    request.onblocked = () => fail('本地壁纸存储正被其他页面占用，请关闭旧页面后重试。')
  })
}

async function runWallpaperRequest<T>(
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openWallpaperDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction
      let request: IDBRequest<T>

      try {
        transaction = database.transaction(WALLPAPER_STORE, mode)
        request = createRequest(transaction.objectStore(WALLPAPER_STORE))
      }
      catch {
        reject(new Error('本地壁纸存储操作失败，请检查浏览器存储空间。'))
        return
      }

      let result = undefined as T
      let settled = false

      const fail = () => {
        if (settled)
          return
        settled = true
        reject(new Error('本地壁纸存储操作失败，请检查浏览器存储空间。'))
      }

      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = fail
      transaction.onerror = fail
      transaction.onabort = fail
      transaction.oncomplete = () => {
        if (settled)
          return
        settled = true
        resolve(result)
      }
    })
  }
  finally {
    database.close()
  }
}

async function decodeWallpaper(file: File): Promise<{ width: number, height: number }> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      validateWallpaperDimensions(dimensions.width, dimensions.height)
      return dimensions
    }
    catch (error) {
      if (error instanceof Error && (error.message.includes('分辨率') || error.message.includes('尺寸')))
        throw error
      throw new Error('图片内容无法解码，请换一张壁纸。')
    }
    finally {
      bitmap?.close()
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        try {
          validateWallpaperDimensions(image.naturalWidth, image.naturalHeight)
          resolve({ width: image.naturalWidth, height: image.naturalHeight })
        }
        catch (error) {
          reject(error)
        }
      }
      image.onerror = () => reject(new Error('图片内容无法解码，请换一张壁纸。'))
      image.src = objectUrl
    })
  }
  finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function loadPersonalWallpaper(): Promise<PersonalWallpaperRecord | null> {
  const record = await runWallpaperRequest<PersonalWallpaperRecord | undefined>(
    'readonly',
    store => store.get(WALLPAPER_KEY),
  )
  return record ?? null
}

export async function savePersonalWallpaper(file: File): Promise<PersonalWallpaperRecord> {
  validateWallpaperFileMetadata(file)
  const dimensions = await decodeWallpaper(file)
  const record: PersonalWallpaperRecord = {
    id: WALLPAPER_KEY,
    blob: file.slice(0, file.size, file.type),
    name: file.name || 'wallpaper',
    type: file.type,
    size: file.size,
    width: dimensions.width,
    height: dimensions.height,
    updatedAt: Date.now(),
  }
  await runWallpaperRequest<IDBValidKey>('readwrite', store => store.put(record))
  return record
}

export async function removePersonalWallpaper(): Promise<void> {
  await runWallpaperRequest<undefined>('readwrite', store => store.delete(WALLPAPER_KEY))
}
