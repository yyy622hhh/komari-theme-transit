import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const collector = resolve('scripts/collect-return-route.sh')
const fixture = resolve('tests/fixtures/collector-security.py')
const key = 'TRANSIT-FAKE-ADMIN-KEY-NOT-A-REAL-CREDENTIAL'
const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()

interface Observation {
  requests: { method: string, url: string, rpc: string, params: { tags?: string }, authorized: boolean }[]
  verified_tls: boolean
  clean_processes: boolean
  clean_environment: boolean
}

function sandbox(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'transit-collector-security-'))
  try {
    writeFileSync(join(directory, 'traceroute'), '#!/bin/sh\nprintf " 1  59.43.1.1  1.0 ms\\n"\n', { mode: 0o700 })
    writeFileSync(join(directory, 'python3'), `#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = -I ] && [ "$2" = - ] || exit 90\nexec ${JSON.stringify(python)} -I ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o700 })
    writeFileSync(join(directory, 'key'), `${key}\n`, { mode: 0o600 })
    run(directory)
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

function execute(directory: string, options: { scenario?: string, url?: string, args?: string[], keyFile?: string | false, legacyEnv?: boolean, terminal?: boolean, printOnly?: boolean } = {}) {
  const observedPath = join(directory, 'observed.json')
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, COLLECTOR_SCENARIO: options.scenario ?? 'success', COLLECTOR_OBSERVED: observedPath }
  for (const name of Object.keys(env)) {
    if (/^(?:https?|all|no)_proxy$/i.test(name) || name === 'KOMARI_API_KEY')
      delete (env as Record<string, string | undefined>)[name]
  }
  if (options.legacyEnv)
    (env as Record<string, string>).KOMARI_API_KEY = key
  const args = [collector, ...(options.printOnly ? [] : ['--push', '--url', options.url ?? 'https://example.invalid', '--uuid', 'fake-node'])]
  if (options.keyFile !== false && !options.printOnly)
    args.push('--key-file', options.keyFile ?? join(directory, 'key'))
  args.push(...(options.args ?? []))
  const result = spawnSync(options.terminal ? python : 'bash', options.terminal ? ['-I', fixture, '--terminal-test', ...args] : args, {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 10000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).not.toContain(key)
  const observed: Observation | undefined = existsSync(observedPath) ? JSON.parse(readFileSync(observedPath, 'utf8')) : undefined
  return { ...result, observed }
}

test('collector refuses legacy argv and environment credentials before probing, without echoing secrets', () => {
  sandbox((directory) => {
    for (const options of [{ args: ['--key', key] }, { args: [`--key=${key}`] }, { legacyEnv: true }]) {
      const result = execute(directory, options)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('不再接受')
      expect(result.stdout).toBe('')
      expect(result.observed).toBeUndefined()
    }
  })
})

const unsafeUrls = ['http://example.invalid', 'http://127.0.0.1', 'file:///tmp/key', 'https://user:password@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?q=1', 'https://example.invalid#x', 'https://example.invalid\\x', 'https://example.invalid\n', 'https://example.invalid:0', 'https://example.invalid:65536', 'https://example.invalid:', 'https://', 'https://[bad']
for (const url of unsafeUrls) {
  test(`collector rejects unsafe URL before reading credentials or making requests: ${JSON.stringify(url)}`, () => {
    sandbox((directory) => {
      const result = execute(directory, { url, keyFile: join(directory, 'missing') })
      expect(result.status, url).toBe(1)
      expect(result.stderr).toContain('HTTPS 源地址')
      expect(result.observed?.requests).toEqual([])
    })
  })
}

for (const code of [301, 302, 303, 307, 308]) {
  for (const scheme of ['https', 'http']) {
    test(`real urllib rejects ${code} redirect to ${scheme} without a second credential-bearing request`, () => {
      sandbox((directory) => {
        const result = execute(directory, { scenario: `redirect-${code}-${scheme}` })
        expect(result.status, result.stderr).toBe(1)
        expect(result.stderr).toContain('重定向')
        expect(result.observed?.requests).toHaveLength(1)
        expect(result.observed?.requests[0]?.rpc).toBe('admin:getClient')
        expect(result.observed?.verified_tls).toBeTrue()
      })
    })
  }
}

for (const mode of [0o400, 0o600]) {
  test(`collector writes back over verified HTTPS using a ${mode.toString(8)} credential file with no argv/env leak`, () => {
    sandbox((directory) => {
      chmodSync(join(directory, 'key'), mode)
      const result = execute(directory, { url: 'https://example.invalid:443/' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.observed?.verified_tls).toBeTrue()
      expect(result.observed?.clean_processes).toBeTrue()
      expect(result.observed?.clean_environment).toBeTrue()
      expect(result.observed?.requests.map(request => [request.rpc, request.method, request.url, request.authorized])).toEqual([
        ['admin:getClient', 'POST', '/api/rpc2', true],
        ['admin:editClient', 'POST', '/api/rpc2', true],
      ])
      expect(result.observed?.requests[1]?.params.tags).toMatch(/^operator-tag;transit-route:ct=4809,cu=4809,cm=4809@\d+$/)
    })
  })
}

for (const fault of ['public', 'group-readable', 'symlink', 'directory', 'fifo', 'wrong-owner', 'missing', 'oversized', 'empty', 'multiline', 'non-ascii']) {
  test(`collector refuses unsafe credentials: ${fault}`, () => {
    sandbox((directory) => {
      let keyFile = join(directory, 'key')
      if (fault === 'public' || fault === 'group-readable')
        chmodSync(keyFile, fault === 'public' ? 0o644 : 0o640)
      if (fault === 'symlink') {
        symlinkSync(keyFile, join(directory, 'link'))
        keyFile = join(directory, 'link')
      }
      if (fault === 'directory')
        keyFile = directory
      if (fault === 'fifo') {
        keyFile = join(directory, 'fifo')
        expect(spawnSync('mkfifo', [keyFile]).status).toBe(0)
      }
      if (fault === 'missing')
        keyFile = join(directory, 'missing')
      const invalid: Record<string, string> = { 'oversized': 'x'.repeat(4097), 'empty': '', 'multiline': 'first\nsecond', 'non-ascii': '不是ASCII' }
      if (fault in invalid)
        writeFileSync(keyFile, invalid[fault]!)
      const result = execute(directory, { keyFile, scenario: fault === 'wrong-owner' ? fault : 'success' })
      expect(result.status, result.stderr).toBe(1)
      expect(result.observed?.requests).toEqual([])
    })
  })
}

for (const scenario of ['bad-certificate', 'rpc-error', 'http-error', 'invalid-json', 'missing-client']) {
  test(`collector fails closed with no raw credential-bearing error output: ${scenario}`, () => {
    sandbox((directory) => {
      const result = execute(directory, { scenario })
      expect(result.status).toBe(1)
      expect(result.observed?.requests).toHaveLength(1)
      const reasons: Record<string, string> = {
        'bad-certificate': '证书校验',
        'rpc-error': '服务端返回错误',
        'http-error': 'HTTP 500',
        'invalid-json': '响应异常',
        'missing-client': '未返回节点对象',
      }
      expect(result.stderr).toContain(reasons[scenario]!)
    })
  })
}

test('server-controlled tags are not echoed into success logs', () => {
  sandbox((directory) => {
    const result = execute(directory, { scenario: 'echo-tags' })
    expect(result.status, result.stderr).toBe(0)
  })
})

test('unattended collection without a key file refuses getpass stdin fallback', () => {
  sandbox((directory) => {
    const result = execute(directory, { keyFile: false, scenario: 'no-terminal' })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('无人值守运行请使用 --key-file')
    expect(result.observed?.requests).toEqual([])
  })
})

test('interactive collection reads a real pseudo-terminal without echo or credential-bearing arguments', () => {
  sandbox((directory) => {
    const result = execute(directory, { keyFile: false, terminal: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('terminal input remained hidden')
    expect(result.observed?.clean_processes).toBeTrue()
    expect(result.observed?.clean_environment).toBeTrue()
    expect(result.observed?.requests).toHaveLength(2)
  })
})

test('print-only helper collection retains its route tag contract without Python or credentials', () => {
  sandbox((directory) => {
    const result = execute(directory, { printOnly: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^transit-route:ct=4809,cu=4809,cm=4809@\d+$/)
    expect(result.observed).toBeUndefined()
  })
})
