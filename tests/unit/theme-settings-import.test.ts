import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useThemeSettingsBackup } from '../../src/composables/useThemeSettingsBackup'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { useAppStore } from '../../src/stores/app'

const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let pinia: ReturnType<typeof createPinia>
let scope: ReturnType<typeof effectScope>
let backup: ReturnType<typeof useThemeSettingsBackup>
let writes: Record<string, unknown>[]
let persisted: Record<string, unknown>
let holdWrite: Promise<void> | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const file = (value: string) => new File([value], 'config.json')
const delayedFile = (text: Promise<string>) => ({ text: () => text }) as File

beforeEach(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } })
  pinia = createPinia()
  setActivePinia(pinia)
  persisted = {}
  writes = []
  holdWrite = undefined
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/me'))
      return Response.json({ logged_in: true, username: 'admin' })
    if (url.endsWith('/api/public'))
      return Response.json({ status: 'success', data: { theme: 'Transit', theme_settings: persisted } })
    if (url.includes('/api/admin/theme/settings?theme=Transit')) {
      const next = JSON.parse(String(init?.body))
      writes.push(next)
      await holdWrite
      persisted = next
      return Response.json({ status: 'success', data: null })
    }
    throw new Error(`Unexpected test endpoint: ${url}`)
  }) as typeof fetch
  const app = useAppStore()
  app.publicSettings = { theme: 'Transit', theme_settings: {} } as NonNullable<typeof app.publicSettings>
  scope = effectScope()
  backup = scope.run(() => useThemeSettingsBackup())!
})

afterEach(() => {
  scope.stop()
  disposePinia(pinia)
  setAuthSessionFromLogin(false)
  globalThis.fetch = originalFetch
  if (originalStorage)
    Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else
    Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('configuration import lifecycle', () => {
  for (const invalid of ['broken JSON', '{"schemaVersion":999,"settings":{}}']) {
    test(`rejects a second file without leaving the first importable: ${invalid}`, async () => {
      await backup.stageImportFile(file('{"alertTitle":"old"}'))
      await backup.stageImportFile(file(invalid))
      expect(backup.importPreview.value).toBeNull()
      expect(backup.importError.value).not.toBeNull()
      await backup.confirmImport()
      expect(writes).toEqual([])
    })
  }
  test('invalidates the previous preview immediately while a new file is reading', async () => {
    await backup.stageImportFile(file('{"alertTitle":"old"}'))
    const text = deferred<string>()
    const pending = backup.stageImportFile(delayedFile(text.promise))
    expect(backup.readingImport.value).toBeTrue()
    expect(backup.importPreview.value).toBeNull()
    await backup.confirmImport()
    expect(writes).toEqual([])
    text.resolve('{"alertTitle":"new"}')
    await pending
    await backup.confirmImport()
    expect(writes).toEqual([{ alertTitle: 'new' }])
  })
  for (const outcome of ['success', 'invalid', 'read-error']) {
    test(`an obsolete ${outcome} cannot overwrite the latest selection`, async () => {
      const text = deferred<string>()
      const pending = backup.stageImportFile(delayedFile(text.promise))
      await backup.stageImportFile(file('{"alertTitle":"latest"}'))
      if (outcome === 'read-error')
        text.reject(new Error('read failed'))
      else
        text.resolve(outcome === 'invalid' ? 'broken' : '{"alertTitle":"obsolete"}')
      await pending
      expect(backup.importPreview.value?.settings).toEqual({ alertTitle: 'latest' })
      expect(backup.importError.value).toBeNull()
      expect(backup.readingImport.value).toBeFalse()
    })
  }
  for (const action of ['cancel', 'rollback', 'dispose']) {
    test(`${action} invalidates a pending file read`, async () => {
      const text = deferred<string>()
      const pending = backup.stageImportFile(delayedFile(text.promise))
      if (action === 'cancel')
        backup.cancelImport()
      else if (action === 'rollback')
        backup.stageRollback({ at: 1, settings: { alertTitle: 'rollback' }, source: 'import' })
      else
        scope.stop()
      text.resolve('{"alertTitle":"late"}')
      await pending
      expect(backup.importPreview.value).toBeNull()
      expect(backup.readingImport.value).toBeFalse()
      if (action === 'rollback')
        expect(backup.rollbackPreview.value?.entry.settings.alertTitle).toBe('rollback')
    })
  }
  test('duplicate confirmations and switching to rollback cannot enqueue a second write', async () => {
    const gate = deferred<void>()
    holdWrite = gate.promise
    await backup.stageImportFile(file('{"alertTitle":"chosen"}'))
    const saving = backup.confirmImport()
    expect(backup.writing.value).toBeTrue()
    await backup.confirmImport()
    backup.stageRollback({ at: 1, settings: {}, source: 'import' })
    await backup.stageImportFile(file('{"alertTitle":"different"}'))
    expect(backup.rollbackPreview.value).toBeNull()
    expect(backup.importPreview.value?.settings.alertTitle).toBe('chosen')
    gate.resolve()
    await saving
    expect(writes).toEqual([{ alertTitle: 'chosen' }])
    expect(backup.writing.value).toBeFalse()
  })
})
