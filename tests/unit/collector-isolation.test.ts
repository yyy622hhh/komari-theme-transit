import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const collector = resolve('scripts/collect-return-route.sh')
const readKeyFailure = '无法安全读取密钥文件'

/** Real interpreter startup, not the HTTP fixture or exec of extracted Python. */
function sandbox(run: (directory: string, env: NodeJS.ProcessEnv, marker: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'transit-python-isolation-'))
  const marker = join(directory, 'untrusted-import-ran')
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  // Only traceroute is mocked. python3 resolves to the original interpreter.
  writeFileSync(join(bin, 'traceroute'), '#!/bin/sh\nprintf " 1  59.43.1.1  1 ms\\n"\n', { mode: 0o700 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  for (const name of Object.keys(env)) {
    if (name.startsWith('PYTHON') || name === 'KOMARI_API_KEY')
      delete (env as NodeJS.ProcessEnv)[name]
  }
  try {
    run(directory, env, marker)
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

function plantModule(file: string, marker: string): void {
  // Harmless proof; no credentials, privileges or network access.
  writeFileSync(file, `with open(${JSON.stringify(marker)}, 'w') as proof:\n    proof.write('untrusted module executed')\nraise SystemExit(86)\n`)
}

function runCollector(directory: string, env: NodeJS.ProcessEnv, script = collector) {
  // The missing key guarantees a stop before any HTTP request. Reaching this
  // error also proves successful startup/imports rather than an unrelated crash.
  return spawnSync('bash', [script, '--push', '--url', 'https://example.invalid', '--uuid', 'fake-node', '--key-file', join(directory, 'missing-key')], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 5000,
  })
}

function expectIsolated(directory: string, env: NodeJS.ProcessEnv, marker: string): void {
  const result = runCollector(directory, env)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(1)
  expect(result.stderr).toContain(readKeyFailure)
  expect(existsSync(marker)).toBeFalse()
}

for (const name of ['getpass', 'json', 'ssl']) {
  test(`actual collector ignores a working-directory ${name}.py module`, () => {
    sandbox((directory, env, marker) => {
      plantModule(join(directory, `${name}.py`), marker)
      expectIsolated(directory, env, marker)
    })
  })
}

for (const name of ['getpass', 'sitecustomize']) {
  test(`actual collector ignores PYTHONPATH ${name}.py injection`, () => {
    sandbox((directory, env, marker) => {
      const injected = join(directory, 'injected')
      mkdirSync(injected)
      plantModule(join(injected, `${name}.py`), marker)
      env.PYTHONPATH = injected
      expectIsolated(directory, env, marker)
    })
  })
}

test('actual collector ignores an invalid PYTHONHOME instead of accepting interpreter configuration injection', () => {
  sandbox((directory, env, marker) => {
    env.PYTHONHOME = join(directory, 'nonexistent-python-home')
    expectIsolated(directory, env, marker)
  })
})

test('actual collector ignores user site customization', () => {
  sandbox((directory, env, marker) => {
    env.PYTHONUSERBASE = join(directory, 'user-base')
    // -s disables user customization during discovery, but permits reading the
    // platform-specific user-site path; do not guess macOS vs Linux layout.
    const discovery = spawnSync('python3', ['-s', '-c', 'import site; print(site.getusersitepackages())'], { cwd: directory, env, encoding: 'utf8', timeout: 5000 })
    expect(discovery.status, discovery.stderr).toBe(0)
    const userSite = discovery.stdout.trim()
    expect(userSite.startsWith(`${directory}/`)).toBeTrue()
    mkdirSync(userSite, { recursive: true })
    plantModule(join(userSite, 'usercustomize.py'), marker)
    expectIsolated(directory, env, marker)
  })
})

test('positive control demonstrates a missing isolation flag would execute an untrusted module', () => {
  sandbox((directory, env, marker) => {
    const source = readFileSync(collector, 'utf8')
    const entry = 'python3 -I - <<\'PY\''
    expect(source).toContain(entry)
    const control = join(directory, 'unisolated-control.sh')
    // Mutate a disposable copy only, never the production script.
    writeFileSync(control, source.replace(entry, 'python3 - <<\'PY\''))
    plantModule(join(directory, 'getpass.py'), marker)
    const result = runCollector(directory, env, control)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(86)
    expect(result.stderr).not.toContain(readKeyFailure)
    expect(readFileSync(marker, 'utf8')).toBe('untrusted module executed')
  })
})
