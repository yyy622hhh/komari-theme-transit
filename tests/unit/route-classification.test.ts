import type { RouteHopEvidence } from '../../src/utils/routeClassification'
import { describe, expect, test } from 'bun:test'
import {
  buildRouteHopEvidence,
  classifyReturnRoute,
  combineRouteClassifications,
  normalizeRouteCarrier,
  resolveHopAsn,
} from '../../src/utils/routeClassification'

/** 和上游 `routeFixture` 对齐：一跳一个 ASN，按给定顺序排列。 */
function hops(...asns: string[]): RouteHopEvidence[] {
  return asns.map((asn, index) => ({ distance: index + 1, asns: [asn] }))
}

describe('电信回程判定', () => {
  // 用例与 backtrace 的 TestClassifyTelecomRequiresOrderedRepeatedEvidence 一致。
  test.each([
    ['只有一跳 CN2 不敢报 GIA', ['AS4809', 'AS4134'], 'ct_cn2_mixed', 3],
    ['两跳 CN2 加一跳交付跳是 GIA', ['AS4809', 'AS4809', 'AS4134'], 'ct_cn2_gia', 5],
    ['CN2 之后还有多跳 163 是混合', ['AS4809', 'AS4809', 'AS4134', 'AS4134'], 'ct_cn2_mixed', 3],
    ['163 排在 CN2 之前是 GT', ['AS4134', 'AS4809', 'AS4809'], 'ct_cn2_gt', 3],
    ['单跳 163 只算目的网', ['AS4134'], 'ct_destination_only', 0],
  ])('%s', (_name, asns, code, rank) => {
    const result = classifyReturnRoute('CT', hops(...asns as string[]))
    expect(result.code).toBe(code as string)
    expect(result.rank).toBe(rank as number)
  })

  test('多跳 163 且无优质骨干证据才判 163', () => {
    const result = classifyReturnRoute('CT', hops('AS4134', 'AS4134'))
    expect(result).toMatchObject({ code: 'ct_163', grade: '普通线路', confidence: 'confirmed' })
  })

  test('CTGNET 在没有 CN2 证据时成立', () => {
    expect(classifyReturnRoute('CT', hops('AS23764', 'AS4134')).code).toBe('ct_ctgnet')
  })

  test('没有任何电信骨干时不给线路名', () => {
    const result = classifyReturnRoute('CT', hops('AS9929'))
    expect(result).toMatchObject({ code: 'ct_unknown', grade: null, confidence: 'inconclusive', rank: 0 })
  })
})

describe('联通回程判定', () => {
  // 用例与 backtrace 的 TestClassifyUnicomAddsCUGAndProtectsDestinationHop 一致。
  test.each([
    [['AS9929', 'AS9929', 'AS4837'], 'cu_9929'],
    [['AS4837', 'AS9929'], 'cu_9929_mixed'],
    [['AS10099'], 'cu_cug'],
    [['AS4837'], 'cu_destination_only'],
  ])('%p 判成 %s', (asns, code) => {
    expect(classifyReturnRoute('CU', hops(...asns as string[])).code).toBe(code as string)
  })

  test('多跳 4837 判普通线路', () => {
    expect(classifyReturnRoute('CU', hops('AS4837', 'AS4837')).code).toBe('cu_4837')
  })
})

describe('移动回程判定', () => {
  // 用例与 backtrace 的 TestClassifyMobileUsesOrderedCMIN2Evidence 一致。
  test('CMIN2 领先时判精品线路', () => {
    expect(classifyReturnRoute('CM', hops('AS58807', 'AS9808')).code).toBe('cm_cmin2')
  })

  test('CMI 排在 CMIN2 之前降级为混合', () => {
    expect(classifyReturnRoute('CM', hops('AS58453', 'AS58807')).code).toBe('cm_cmin2_mixed')
  })

  test('只有 CMNET 判普通线路', () => {
    expect(classifyReturnRoute('CM', hops('AS9808')).code).toBe('cm_cmnet')
  })

  test('只有 CMI 判普通线路', () => {
    expect(classifyReturnRoute('CM', hops('AS58453')).code).toBe('cm_cmi')
  })
})

describe('多次探测结论合并', () => {
  // 用例与 backtrace 的 TestCombineRouteClassificationsDowngradesDynamicDisagreement 一致。
  test('结论打架时降级为动态混合而不是取最优', () => {
    const result = combineRouteClassifications('CU', [
      classifyReturnRoute('CU', hops('AS9929')),
      classifyReturnRoute('CU', hops('AS4837', 'AS4837')),
    ])
    expect(result).toMatchObject({ code: 'cu_dynamic_mixed', confidence: 'mixed', rank: 3 })
  })

  test('证据不足的那次让位给有结论的那次', () => {
    const result = combineRouteClassifications('CT', [
      classifyReturnRoute('CT', hops('AS4134')),
      classifyReturnRoute('CT', hops('AS4809', 'AS4809')),
    ])
    expect(result.code).toBe('ct_cn2_gia')
  })

  test('全部证据不足时保留第一条结论', () => {
    const result = combineRouteClassifications('CT', [
      classifyReturnRoute('CT', hops('AS4134')),
      classifyReturnRoute('CT', hops()),
    ])
    expect(result.code).toBe('ct_destination_only')
  })

  test('没有任何结论时给出兜底', () => {
    expect(combineRouteClassifications('CM', []).code).toBe('cm_unknown')
  })
})

describe('运营商代号归一', () => {
  test.each([
    ['电信', 'CT'],
    ['telecom', 'CT'],
    ['联通', 'CU'],
    ['cmcc', 'CM'],
    ['移动', 'CM'],
  ])('%s 归一为 %s', (input, expected) => {
    expect(normalizeRouteCarrier(input as string)).toBe(expected as string)
  })

  test('未知运营商不给线路名', () => {
    expect(classifyReturnRoute('AWS', hops('AS4809', 'AS4809'))).toMatchObject({
      code: 'unknown_carrier',
      confidence: 'inconclusive',
    })
  })
})

describe('跳点地址映射 ASN', () => {
  test.each([
    ['59.43.130.1', 'AS4809'],
    ['202.97.94.1', 'AS4134'],
    ['218.105.129.1', 'AS9929'],
    ['210.51.15.1', 'AS9929'],
    ['219.158.16.1', 'AS4837'],
    ['221.183.55.1', 'AS9808'],
    ['111.24.6.1', 'AS9808'],
    ['69.194.1.1', 'AS23764'],
  ])('%s -> %s', (ip, asn) => {
    expect(resolveHopAsn(ip as string)).toBe(asn as string)
  })

  test('CMIN2 的细分段优先于 CMI 的宽前缀', () => {
    expect(resolveHopAsn('223.120.130.1')).toBe('AS58807')
    expect(resolveHopAsn('223.119.10.1')).toBe('AS58807')
    expect(resolveHopAsn('223.118.32.1')).toBe('AS58807')
    // 同在 223.120/223.119 里但不属于 CMIN2 段的仍是 CMI。
    expect(resolveHopAsn('223.120.10.1')).toBe('AS58453')
    expect(resolveHopAsn('223.119.200.1')).toBe('AS58453')
    expect(resolveHopAsn('223.121.1.1')).toBe('AS58453')
  })

  test('按整段比对，不会命中相邻的 /8', () => {
    // 上游的裸字符串前缀会把这三个误判成 AS9808 / AS10099 / AS23764。
    expect(resolveHopAsn('111.240.1.1')).toBe('')
    expect(resolveHopAsn('61.140.1.1')).toBe('')
    expect(resolveHopAsn('203.220.1.1')).toBe('')
    // 真正的整段仍然认得。
    expect(resolveHopAsn('61.14.1.1')).toBe('AS10099')
    expect(resolveHopAsn('203.22.1.1')).toBe('AS23764')
  })

  test('非法地址和 IPv6 返回空串', () => {
    expect(resolveHopAsn('')).toBe('')
    expect(resolveHopAsn('59.43.1')).toBe('')
    expect(resolveHopAsn('59.43.1.256')).toBe('')
    expect(resolveHopAsn('2400:89c0:1053:3::69')).toBe('')
  })
})

describe('从跳点地址构造证据', () => {
  test('认不出的跳保留位置，不打乱先后关系', () => {
    const evidence = buildRouteHopEvidence(['1.1.1.1', '59.43.1.1', '59.43.2.1', '202.97.1.1'])
    expect(evidence).toEqual([
      { distance: 1, asns: [] },
      { distance: 2, asns: ['AS4809'] },
      { distance: 3, asns: ['AS4809'] },
      { distance: 4, asns: ['AS4134'] },
    ])
    expect(classifyReturnRoute('CT', evidence).code).toBe('ct_cn2_gia')
  })

  test('同一跳的多个地址去重后并列', () => {
    expect(buildRouteHopEvidence([['59.43.1.1', '59.43.2.2', '202.97.1.1']])).toEqual([
      { distance: 1, asns: ['AS4809', 'AS4134'] },
    ])
  })

  test('一整条真实形态的 163 回程', () => {
    const evidence = buildRouteHopEvidence([
      '10.0.0.1',
      '203.0.113.1',
      '202.97.12.1',
      '202.97.94.1',
      '202.97.33.1',
      '219.141.140.10',
    ])
    expect(classifyReturnRoute('CT', evidence)).toMatchObject({
      code: 'ct_163',
      label: '电信163',
      grade: '普通线路',
      confidence: 'confirmed',
    })
  })
})
