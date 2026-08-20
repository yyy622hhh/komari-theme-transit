import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearTopologyWriteLog, readTopologyWriteLog, recordTopologyWrite, summarizeTaskNames } from '../../src/utils/topologyWriteLog'

const originalSessionStorage = globalThis.sessionStorage

function installSessionStorage(): Map<string, string> {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
  return store
}

beforeEach(() => {
  installSessionStorage()
})

afterEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: originalSessionStorage })
})

describe('topology write log', () => {
  test('records newest first, so the last thing the theme did is at the top', () => {
    recordTopologyWrite({ trigger: 'manual', action: '创建入口探测任务 北京电信', outcome: 'ok', at: 1 })
    recordTopologyWrite({ trigger: 'auto', action: '清理旧探测任务', outcome: 'failed', detail: '删除请求未成功', at: 2 })

    const log = readTopologyWriteLog()
    expect(log.map(entry => entry.action)).toEqual(['清理旧探测任务', '创建入口探测任务 北京电信'])
    expect(log[0]).toMatchObject({ trigger: 'auto', outcome: 'failed', detail: '删除请求未成功', at: 2 })
  })

  test('stamps the time when the caller does not supply one', () => {
    const before = Date.now()
    recordTopologyWrite({ trigger: 'auto', action: '创建探测任务', outcome: 'ok' })
    expect(readTopologyWriteLog()[0]!.at).toBeGreaterThanOrEqual(before)
  })

  test('caps the log so a long-running tab cannot grow it without bound', () => {
    for (let index = 0; index < 80; index++)
      recordTopologyWrite({ trigger: 'auto', action: `第 ${index} 次`, outcome: 'ok', at: index })

    const log = readTopologyWriteLog()
    expect(log).toHaveLength(60)
    expect(log[0]!.action).toBe('第 79 次')
  })

  test('drops corrupt entries instead of throwing at the caller', () => {
    // 流水是排查用的附加信息，读坏了最多是少几行，绝不能反过来让拓扑管理器打不开。
    sessionStorage.setItem('transit:topology-write-log', '[{"at":1,"action":"good","trigger":"auto","outcome":"ok"},null,{"action":"missing-at"},42]')
    expect(readTopologyWriteLog()).toEqual([{ at: 1, action: 'good', trigger: 'auto', outcome: 'ok' }])

    sessionStorage.setItem('transit:topology-write-log', 'not json')
    expect(readTopologyWriteLog()).toEqual([])

    sessionStorage.setItem('transit:topology-write-log', '{"not":"an array"}')
    expect(readTopologyWriteLog()).toEqual([])
  })

  test('clears completely', () => {
    recordTopologyWrite({ trigger: 'manual', action: '创建', outcome: 'ok' })
    clearTopologyWriteLog()
    expect(readTopologyWriteLog()).toEqual([])
  })

  test('is a no-op without sessionStorage rather than crashing', () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: undefined })
    expect(() => recordTopologyWrite({ trigger: 'auto', action: '创建', outcome: 'ok' })).not.toThrow()
    expect(readTopologyWriteLog()).toEqual([])
  })
})

describe('summarizeTaskNames', () => {
  test('lists a few names in full', () => {
    expect(summarizeTaskNames(['北京电信', '上海联通'])).toBe('北京电信、上海联通')
  })

  test('collapses a long list so one line stays readable', () => {
    expect(summarizeTaskNames(['a', 'b', 'c', 'd', 'e'])).toBe('a、b、c 等 5 个')
  })

  test('ignores blank names and returns an empty string when nothing is left', () => {
    expect(summarizeTaskNames([' ', ''])).toBe('')
    expect(summarizeTaskNames(['  北京电信  ', ''])).toBe('北京电信')
  })
})
