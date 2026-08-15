import { describe, expect, test } from 'bun:test'
import { createAsyncGeneration } from '../../src/utils/asyncGeneration'

describe('async generation commit gate', () => {
  test('only keeps the newest request generation current', () => {
    const requests = createAsyncGeneration()
    const first = requests.begin()
    const second = requests.begin()

    expect(requests.isCurrent(first)).toBe(false)
    expect(requests.isCurrent(second)).toBe(true)
  })

  test('invalidates active work without starting a replacement', () => {
    const requests = createAsyncGeneration()
    const active = requests.begin()

    requests.invalidate()

    expect(requests.isCurrent(active)).toBe(false)
  })

  test('rejects every late result after disposal', () => {
    const requests = createAsyncGeneration()
    const active = requests.begin()

    requests.dispose()
    const afterDispose = requests.begin()

    expect(requests.isCurrent(active)).toBe(false)
    expect(requests.isCurrent(afterDispose)).toBe(false)
  })
})
