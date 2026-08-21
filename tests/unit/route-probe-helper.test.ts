import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const helper = readFileSync(new URL('../../scripts/transit-route-probe-helper.sh', import.meta.url), 'utf8')

describe('Transit Route Probe node helper security contract', () => {
  test('只接受三个固定城市且不读取服务端目标地址', () => {
    expect(helper).toContain('beijing) city_code=bj')
    expect(helper).toContain('shanghai) city_code=sh')
    expect(helper).toContain('guangzhou) city_code=gz')
    expect(helper).not.toMatch(/target[_-]?ip/i)
  })

  test('不使用 eval、shell -c 或服务端返回的命令', () => {
    expect(helper).not.toMatch(/\beval\b/)
    expect(helper).not.toMatch(/(?:bash|sh)\s+-c/)
    expect(helper).not.toMatch(/\bcommand_payload\b/)
  })

  test('默认要求 HTTPS 且 token 不出现在 systemd 命令行', () => {
    expect(helper).toContain('https://*')
    expect(helper).toContain('endpoint 必须是无空白字符的 HTTPS 地址')
    expect(helper).not.toMatch(/ExecStart=.*(?:--token|\$TOKEN)/)
  })

  test('服务以专用用户和收缩后的 systemd 权限运行', () => {
    expect(helper).toContain('NoNewPrivileges=true')
    expect(helper).toContain('ProtectSystem=strict')
    expect(helper).toContain('CapabilityBoundingSet=CAP_NET_RAW')
    expect(helper).toContain('RestrictAddressFamilies=AF_INET AF_INET6')
  })
})
