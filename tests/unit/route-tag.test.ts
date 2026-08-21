import { describe, expect, test } from 'bun:test'
import { formatNodeRouteTag, isNodeRouteTag, parseNodeRouteTag } from '../../src/utils/routeTag'
import { parseTags } from '../../src/utils/tagHelper'

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function stamp(msAgo: number): number {
  return Math.floor((NOW - msAgo) / 1000)
}

describe('回程标签解析', () => {
  test('三网俱全的标签解析出三条判定', () => {
    const report = parseNodeRouteTag(
      `香港<blue>;transit-route:ct=4809.4809.4134,cu=4837.4837,cm=58807.9808@${stamp(HOUR)};中转`,
      NOW,
    )!
    expect(report.entries.map(entry => entry.carrier)).toEqual(['CT', 'CU', 'CM'])
    expect(report.entries.map(entry => entry.classification.code)).toEqual(['ct_cn2_gia', 'cu_4837', 'cm_cmin2'])
    expect(report.entries[0]).toMatchObject({ carrierLabel: '电信', asns: ['AS4809', 'AS4809', 'AS4134'] })
    expect(report.measuredAt).toBe(NOW - HOUR)
    expect(report.freshness).toBe('fresh')
  })

  test('只写一家运营商也成立', () => {
    const report = parseNodeRouteTag('transit-route:cu=9929.9929', NOW)!
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]!.classification.code).toBe('cu_9929')
    expect(report.measuredAt).toBeNull()
  })

  test('空值表示探了但没认出骨干，和缺省不是一回事', () => {
    const report = parseNodeRouteTag('transit-route:ct=,cm=58453', NOW)!
    expect(report.entries.map(entry => entry.carrier)).toEqual(['CT', 'CM'])
    expect(report.entries[0]!.classification).toMatchObject({ code: 'ct_unknown', confidence: 'inconclusive' })
    expect(report.entries[1]!.classification.code).toBe('cm_cmi')
  })

  test('前缀大小写不敏感，书写顺序不影响展示顺序', () => {
    const report = parseNodeRouteTag('TRANSIT-ROUTE:cm=58807,ct=4809.4809', NOW)!
    expect(report.entries.map(entry => entry.carrier)).toEqual(['CT', 'CM'])
  })

  test('ASN 可以带或不带 AS 前缀之外的杂项，非数字段被丢弃', () => {
    const report = parseNodeRouteTag('transit-route:ct=4809.abc.4809', NOW)!
    expect(report.entries[0]!.asns).toEqual(['AS4809', 'AS4809'])
    expect(report.entries[0]!.classification.code).toBe('ct_cn2_gia')
  })

  test.each([
    ['没有标签', ''],
    ['没有保留前缀', '香港;中转'],
    ['前缀后面是空的', 'transit-route:'],
    ['运营商代号不认识', 'transit-route:aws=4809'],
    ['缺少等号', 'transit-route:ct4809'],
  ])('%s 时返回 null', (_name, tags) => {
    expect(parseNodeRouteTag(tags as string, NOW)).toBeNull()
  })

  test('重复的运营商只取第一条', () => {
    const report = parseNodeRouteTag('transit-route:ct=4809.4809,ct=4134.4134', NOW)!
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]!.classification.code).toBe('ct_cn2_gia')
  })

  test('坏掉的时间戳不会把整条标签判废', () => {
    const report = parseNodeRouteTag('transit-route:ct=4809.4809@notanumber', NOW)!
    expect(report.measuredAt).toBeNull()
    expect(report.entries[0]!.classification.code).toBe('ct_cn2_gia')
  })

  test('原始标签原样保留，便于排障', () => {
    expect(parseNodeRouteTag('a;transit-route:ct=4134.4134;b', NOW)!.raw).toBe('transit-route:ct=4134.4134')
  })
})

describe('回程标签新鲜度', () => {
  test.each([
    ['刚采集完是 fresh', HOUR, 'fresh'],
    ['超过一天提示可能不是最新', 2 * DAY, 'delayed'],
    ['超过一周不再可信', 8 * DAY, 'stale'],
  ])('%s', (_name, age, expected) => {
    const report = parseNodeRouteTag(`transit-route:ct=4134.4134@${stamp(age as number)}`, NOW)!
    expect(report.freshness).toBe(expected as string)
  })

  test('没有时间戳时明确标为 unknown，不伪装成当前结果', () => {
    expect(parseNodeRouteTag('transit-route:ct=4134.4134', NOW)!.freshness).toBe('unknown')
  })
})

describe('保留标签不污染普通标签', () => {
  test('parseTags 滤掉保留标签', () => {
    const tags = parseTags('香港<blue>;transit-route:ct=4809.4809@1755000000;中转<green>')
    expect(tags.map(tag => tag.text)).toEqual(['香港', '中转'])
  })

  test('只有保留标签时普通标签为空', () => {
    expect(parseTags('transit-route:ct=4809.4809')).toEqual([])
  })

  test('isNodeRouteTag 认前缀不认内容', () => {
    expect(isNodeRouteTag(' transit-route:whatever ')).toBe(true)
    expect(isNodeRouteTag('transit-routes:ct=1')).toBe(false)
    expect(isNodeRouteTag('香港')).toBe(false)
  })
})

describe('回程标签生成', () => {
  test('生成的标签能被解析回同样的判定', () => {
    const tag = formatNodeRouteTag({ CT: ['AS4809', 'AS4809', 'AS4134'], CU: [], CM: ['58807'] }, NOW)
    expect(tag).toBe(`transit-route:ct=4809.4809.4134,cu=,cm=58807@${Math.floor(NOW / 1000)}`)

    const report = parseNodeRouteTag(tag, NOW)!
    expect(report.entries.map(entry => entry.classification.code)).toEqual(['ct_cn2_gia', 'cu_unknown', 'cm_cmin2'])
    expect(report.measuredAt).toBe(NOW)
  })

  test('未提供的运营商不出现在标签里', () => {
    expect(formatNodeRouteTag({ CT: ['4134', '4134'] })).toBe('transit-route:ct=4134.4134')
  })
})
