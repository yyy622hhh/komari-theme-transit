import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const plugin = readFileSync(new URL('../../companion/transit-route-probe/script.js', import.meta.url), 'utf8')
const storage = readFileSync(new URL('../../companion/transit-route-probe/storage.cjs', import.meta.url), 'utf8')

describe('Transit Route Probe plugin persistence contract', () => {
  test('只在 Komari 长期存储目录保存 state-v1.json 且不保存 token', () => {
    expect(storage).toContain('\'state-v1.json\'')
    expect(plugin).toContain('globalThis.__storageDir__')
    expect(plugin).not.toMatch(/JSON\.stringify\([^\n]*token/i)
  })

  test('同目录临时文件原子替换并保留损坏副本', () => {
    expect(storage).toContain('this.fs.writeFileSync(temporary')
    expect(storage).toContain('this.fs.renameSync(temporary, this.file)')
    expect(storage).toContain('state-v1.corrupt-')
  })

  test('任务变更立即落盘，普通心跳一分钟检查点', () => {
    expect(storage).toContain('60000')
    expect(plugin).toContain('checkpointHeartbeat()')
    expect(plugin).toContain('storage.persist(true)')
  })

  test('认证失败向助手返回数字型 Retry-After', () => {
    expect(plugin).toMatch(/res\.setHeader\('Retry-After', '300'\)/)
  })
})
