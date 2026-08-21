import { describe, expect, test } from 'bun:test'
import { classifyReturnRoute } from '../../src/utils/routeClassification'
import { formatNodeRouteTag } from '../../src/utils/routeTag'
import {
  buildRouteTraceCommand,
  isMissingTracerouteOutput,
  isUsableRouteTraceOutput,
  parseRouteTraceOutput,
  ROUTE_TRACE_MISSING_MARKER,
  routeTraceTargets,
} from '../../src/utils/routeTrace'

/** 一段贴近真实形态的 traceroute 输出：有星号跳、有私网跳、有认不出的跳。 */
const REAL_OUTPUT = `__TRANSIT_ROUTE_CT__
traceroute to 219.141.140.10 (219.141.140.10), 30 hops max, 60 byte packets
 1  10.0.0.1  0.512 ms
 2  *
 3  1.1.1.1  1.204 ms
 4  59.43.130.1  120.113 ms
 5  59.43.82.2  130.402 ms
 6  202.97.94.1  140.221 ms
 7  219.141.140.10  142.010 ms
__TRANSIT_ROUTE_CU__
traceroute to 202.106.195.68 (202.106.195.68), 30 hops max, 60 byte packets
 1  10.0.0.1  0.480 ms
 2  219.158.16.1  150.002 ms
 3  219.158.3.65  152.114 ms
 4  202.106.195.68  155.003 ms
__TRANSIT_ROUTE_CM__
 1  10.0.0.1  0.470 ms
 2  223.120.140.1  160.008 ms
 3  221.183.55.1  165.221 ms
 4  221.179.155.161  168.114 ms
`

describe('采集命令生成', () => {
  test('北京三家的目标取自入口预设表', () => {
    expect(routeTraceTargets('beijing')).toEqual({
      CT: '219.141.140.10',
      CU: '202.106.195.68',
      CM: '221.179.155.161',
    })
  })

  test('三个城市都能取到完整的三家', () => {
    for (const city of ['beijing', 'shanghai', 'guangzhou'] as const) {
      const targets = routeTraceTargets(city)
      expect(Object.keys(targets).sort()).toEqual(['CM', 'CT', 'CU'])
      for (const target of Object.values(targets))
        expect(target).toMatch(/^(?:\d{1,3}\.){3}\d{1,3}$/)
    }
  })

  test('命令里只有预设表的常量地址，没有任何外部输入', () => {
    const command = buildRouteTraceCommand('beijing')
    const targets = Object.values(routeTraceTargets('beijing'))
    // 命令中出现的每一个 IPv4 字面量都必须来自预设表。
    const literals = [...new Set(command.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? [])]
    expect(literals.sort()).toEqual([...targets].sort())
  })

  test('命令不含 shell 变量展开', () => {
    const command = buildRouteTraceCommand('beijing')
    expect(command).not.toMatch(/\$\{|\$\(|`/)
  })

  test('先探 traceroute 是否存在，ICMP 不通再退 UDP', () => {
    const command = buildRouteTraceCommand('beijing')
    expect(command).toContain('command -v traceroute')
    expect(command).toContain(ROUTE_TRACE_MISSING_MARKER)
    expect(command).toContain('traceroute -I -n')
    expect(command).toContain('|| traceroute -n')
  })
})

describe('采集输出解析', () => {
  test('真实形态的输出解析出三家的骨干跳', () => {
    expect(parseRouteTraceOutput(REAL_OUTPUT)).toEqual({
      CT: ['AS4809', 'AS4809', 'AS4134'],
      CU: ['AS4837', 'AS4837'],
      CM: ['AS58807', 'AS9808'],
    })
  })

  test('解析结果接上判线得到预期线路', () => {
    const parsed = parseRouteTraceOutput(REAL_OUTPUT)
    const codeOf = (carrier: 'CT' | 'CU' | 'CM') => classifyReturnRoute(
      carrier,
      parsed[carrier]!.map((asn, index) => ({ distance: index + 1, asns: [asn] })),
    ).code
    expect(codeOf('CT')).toBe('ct_cn2_gia')
    expect(codeOf('CU')).toBe('cu_4837')
    expect(codeOf('CM')).toBe('cm_cmin2')
  })

  test('解析结果能直接编码成标签并原样读回', () => {
    const parsed = parseRouteTraceOutput(REAL_OUTPUT)
    expect(formatNodeRouteTag(parsed)).toBe('transit-route:ct=4809.4809.4134,cu=4837.4837,cm=58807.9808')
  })

  test('探了但没认出骨干跳，记成空数组而不是缺席', () => {
    const parsed = parseRouteTraceOutput('__TRANSIT_ROUTE_CT__\n 1  10.0.0.1  0.5 ms\n 2  * \n')
    expect(parsed).toEqual({ CT: [] })
    // 空数组和缺席在标签里必须编码成不同的东西。
    expect(formatNodeRouteTag(parsed)).toBe('transit-route:ct=')
  })

  test('某家整段缺失时不会串到别家名下', () => {
    const parsed = parseRouteTraceOutput('__TRANSIT_ROUTE_CU__\n 1  219.158.16.1  1 ms\n 2  219.158.3.1  1 ms\n')
    expect(parsed).toEqual({ CU: ['AS4837', 'AS4837'] })
  })

  test('分段标记之前的行被忽略', () => {
    const parsed = parseRouteTraceOutput(' 1  59.43.1.1  1 ms\n__TRANSIT_ROUTE_CT__\n 1  202.97.1.1  1 ms\n')
    expect(parsed).toEqual({ CT: ['AS4134'] })
  })

  test.each([
    ['节点没装 traceroute', `${ROUTE_TRACE_MISSING_MARKER}\n`],
    ['输出为空', ''],
    ['命令根本没跑起来', 'sh: 1: syntax error\n'],
    ['节点离线时服务端写入的占位', 'Client offline!'],
  ])('%s 时不产出可用结果', (_name, output) => {
    expect(parseRouteTraceOutput(output as string)).toEqual({})
    expect(isUsableRouteTraceOutput(output as string)).toBe(false)
  })

  test('真实输出被判为可用', () => {
    expect(isUsableRouteTraceOutput(REAL_OUTPUT)).toBe(true)
  })

  test('「没装 traceroute」和别的失败要分得开', () => {
    // 前者运营者能自己修，后者只能报错，界面上给的话不一样。
    expect(isMissingTracerouteOutput(`${ROUTE_TRACE_MISSING_MARKER}\n`)).toBe(true)
    expect(isMissingTracerouteOutput('Client offline!')).toBe(false)
    expect(isMissingTracerouteOutput(REAL_OUTPUT)).toBe(false)
    expect(isMissingTracerouteOutput('')).toBe(false)
  })

  test('命令里的标记与解析用的是同一个常量', () => {
    expect(buildRouteTraceCommand('beijing')).toContain(ROUTE_TRACE_MISSING_MARKER)
  })

  test('三家都探到但一个骨干跳都没认出，必须能被判成采集失败', () => {
    // 主题侧和节点侧采集脚本都靠这个条件决定「不写回」——写了会把上次的好结果
    // 覆盖成「未见骨干」，还让这台机器七天内不再重测。两条路径必须判得一样。
    const parsed = parseRouteTraceOutput([
      '__TRANSIT_ROUTE_CT__',
      ' 1  10.0.0.1  0.5 ms',
      ' 2  *',
      '__TRANSIT_ROUTE_CU__',
      ' 1  10.0.0.1  0.5 ms',
      '__TRANSIT_ROUTE_CM__',
      ' 2  *',
    ].join('\n'))

    expect(parsed).toEqual({ CT: [], CU: [], CM: [] })
    // 「有分段标记」不等于「有可用结果」，这两个判断不能混用。
    expect(isUsableRouteTraceOutput(JSON.stringify(parsed))).toBe(false)
    expect(Object.values(parsed).every(asns => !asns.length)).toBe(true)
  })

  test('只要有一家认出骨干跳就不算失败', () => {
    const parsed = parseRouteTraceOutput([
      '__TRANSIT_ROUTE_CT__',
      ' 1  *',
      '__TRANSIT_ROUTE_CU__',
      ' 1  219.158.16.1  1 ms',
      '__TRANSIT_ROUTE_CM__',
      ' 1  *',
    ].join('\n'))
    expect(Object.values(parsed).every(asns => !asns.length)).toBe(false)
  })
})
