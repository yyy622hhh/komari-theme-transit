import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { buildRouteProbeInstallCommand } from '../../src/utils/routeProbeInstall'

const helper = resolve('scripts/transit-route-probe-helper.sh')
function sandbox(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'transit-security-test-'))
  try {
    run(directory)
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
function shell(directory: string, script: string) {
  return spawnSync('bash', ['-s', helper, directory], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5000,
    input: `source "$1"\nSANDBOX="$2"\n${script}`,
  })
}

test('endpoint validation rejects remote HTTP, URL credentials, paths and configuration injection', () => {
  sandbox((directory) => {
    const allowed = ['https://example.invalid', 'https://example.invalid:443', 'https://[::1]:443']
    const rejected = ['http://example.invalid', 'http://127.0.0.1', 'https://name:pass@example.invalid', 'https://example.invalid/?a=1', 'https://example.invalid#fragment', 'https://example.invalid\\x', 'https://example.invalid:0', 'https://example.invalid:65536', 'https://example.invalid\nheader=x']
    for (const endpoint of [...allowed, ...rejected]) {
      const result = spawnSync('bash', ['-s', helper, endpoint], { input: 'source "$1"\nvalid_endpoint "$2"\n', encoding: 'utf8' })
      expect(result.status === 0, endpoint).toBe(allowed.includes(endpoint))
    }
    const result = shell(directory, `ALLOW_INSECURE_HTTP=1
valid_endpoint http://127.0.0.1:25774 || exit 1
valid_endpoint 'http://[::1]:25774' || exit 1
if valid_endpoint http://public.example.invalid; then exit 1; fi
if valid_endpoint http://127.0.0.1.example.invalid; then exit 1; fi
if valid_endpoint http://localhost; then exit 1; fi`)
    expect(result.status, result.stderr).toBe(0)
  })
})

for (const mode of ['safe', 'symlink', 'public', 'write-failure'] as const) {
  test(`secure polling isolates files and fails closed: ${mode}`, () => {
    sandbox((directory) => {
      const runtime = mkdtempSync(join(directory, 'runtime-'))
      const victim = join(directory, 'victim')
      writeFileSync(victim, 'unchanged', { mode: 0o644 })
      symlinkSync(victim, join(runtime, 'poll.curl'))
      const runtimeLink = join(directory, 'link')
      symlinkSync(runtime, runtimeLink)
      if (mode === 'public')
        chmodSync(runtime, 0o777)
      const result = shell(directory, `
RUNTIME_DIRECTORY=${JSON.stringify(mode === 'symlink' ? runtimeLink : runtime)}
read_config() { ENDPOINT=https://example.invalid; TOKEN=secret-token; }
timeout() { return 0; }
${mode === 'write-failure' ? 'printf() { return 1; }' : ''}
curl() {
  builtin printf '%s\n' "$@" > "$SANDBOX/args"
  local config='' payload='' headers='' output=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --config) config="$2"; shift;; --data-binary) payload="\${2#@}"; shift;; --dump-header) headers="$2"; shift;; --output) output="$2"; shift;; esac
    shift
  done
  cp "$config" "$SANDBOX/config-seen"
  cp "$payload" "$SANDBOX/body-seen"
  ${JSON.stringify(process.execPath)} -e 'console.log((require("fs").statSync(process.argv[1]).mode & 511).toString(8))' "$payload" > "$SANDBOX/mode"
  builtin printf '\n' > "$headers"
  builtin printf '\n' > "$output"
  builtin printf 204
}
poll_once ignored
`)
      expect(readFileSync(victim, 'utf8')).toBe('unchanged')
      expect(result.stdout + result.stderr).not.toContain('secret-token')
      if (mode === 'safe') {
        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(join(directory, 'body-seen'), 'utf8'))).toEqual({ token: 'secret-token' })
        expect(readFileSync(join(directory, 'config-seen'), 'utf8')).not.toContain('token')
        const args = readFileSync(join(directory, 'args'), 'utf8')
        expect(args).toStartWith('-q\n')
        expect(args).toContain('POST')
        expect(args).not.toContain('secret-token')
        expect(readFileSync(join(directory, 'mode'), 'utf8').trim()).toBe('600')
      }
      else {
        expect(result.status).not.toBe(0)
        expect(existsSync(join(directory, 'args'))).toBeFalse()
      }
      expect(readdirSync(runtime)).toEqual(['poll.curl'])
    })
  })
}

test('credential writer refuses pre-existing files and result fields cannot inject JSON', () => {
  sandbox((directory) => {
    const file = join(directory, 'existing')
    writeFileSync(file, 'unchanged', { mode: 0o644 })
    const result = shell(directory, `TOKEN=secret-token
if write_request_json "$SANDBOX/existing"; then exit 1; fi
if write_request_json "$SANDBOX/invalid" j_01234567 error 'bad"value'; then exit 1; fi
write_request_json "$SANDBOX/result" j_01234567 tag 'transit-route:ct=4809,cu=,cm=@1700000000' 1234`)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('unchanged')
    expect(existsSync(join(directory, 'invalid'))).toBeFalse()
    expect(JSON.parse(readFileSync(join(directory, 'result'), 'utf8'))).toEqual({ token: 'secret-token', job_id: 'j_01234567', tag: 'transit-route:ct=4809,cu=,cm=@1700000000', duration_ms: 1234 })
  })
})

test('manual polling allocates distinct private directories and removes only its own files', () => {
  sandbox((directory) => {
    const result = shell(directory, `unset RUNTIME_DIRECTORY
create_runtime || exit 1
first="$RUNTIME_WORK_DIR"
cleanup_runtime || exit 1
[ ! -e "$first" ] || exit 1
create_runtime || exit 1
[ "$first" != "$RUNTIME_WORK_DIR" ] || exit 1
cleanup_runtime`)
    expect(result.status, result.stderr).toBe(0)
  })
})

for (const fault of ['first-download', 'second-download', 'install', 'none']) {
  test(`generated installation command checks each download in a private directory: ${fault}`, () => {
    sandbox((directory) => {
      writeFileSync(join(directory, 'transit-route-probe-helper.sh'), 'echo WRONG_OLD_SCRIPT')
      writeFileSync(join(directory, 'collect-return-route.sh'), 'old-collector')
      const command = buildRouteProbeInstallCommand('https://example.invalid', 'v1.4.1')
      const result = shell(directory, `
mktemp() { command mktemp -d "$SANDBOX/work.XXXXXXXX"; }
curl() {
  local output=''
  while [ "$#" -gt 0 ]; do case "$1" in -o) output="$2"; shift;; esac; shift; done
  printf '%s\n' "$output" >> "$SANDBOX/downloads"
  [ '${fault}' != first-download ] || return 22
  if [ "$output" = collect-return-route.sh ] && [ '${fault}' = second-download ]; then return 22; fi
  printf 'fresh-download' > "$output"
}
sudo() {
  printf '%s\n' "$PWD" > "$SANDBOX/installed"
  [ "$(command stat -c %a "$PWD" 2>/dev/null || command stat -f %Lp "$PWD")" = 700 ] || return 1
  [ "$(command cat "$2")" = fresh-download ] || return 1
  [ "$(command cat collect-return-route.sh)" = fresh-download ] || return 1
  [ '${fault}' != install ]
}
${command}
`)
      expect(result.stdout + result.stderr).not.toContain('WRONG_OLD_SCRIPT')
      expect(readFileSync(join(directory, 'collect-return-route.sh'), 'utf8')).toBe('old-collector')
      expect(existsSync(join(directory, 'installed'))).toBe(fault === 'none' || fault === 'install')
      expect(result.status === 0).toBe(fault === 'none')
      expect(readdirSync(directory).some(name => name.startsWith('work.'))).toBeFalse()
    })
  })
}

test('production installer commands reject untrusted origins and release shell fragments', () => {
  for (const endpoint of ['http://127.0.0.1', 'https://u:p@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?x=1'])
    expect(buildRouteProbeInstallCommand(endpoint, 'v1.4.1')).toBe('')
  expect(buildRouteProbeInstallCommand('https://example.invalid', 'v1.4.1; touch /tmp/unsafe')).toBe('')
})
