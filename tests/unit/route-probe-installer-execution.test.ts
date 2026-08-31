import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const helper = resolve('scripts/transit-route-probe-helper.sh')
const source = readFileSync(helper, 'utf8').split('# Sourcing exposes')[0]!

/** Execute the real installer; only privileged commands and absolute destinations are sandboxed. */
function execute(fault = '', existing = false) {
  const directory = mkdtempSync(join(tmpdir(), 'transit-install-test-'))
  const config = join(directory, 'config')
  const unit = join(directory, 'unit.service')
  try {
    writeFileSync(join(directory, 'agent-token'), 'secret-token\n', { mode: 0o600 })
    if (existing)
      writeFileSync(config, 'old-safe-config', { mode: 0o640 })
    const anchor = 'local service_file="/etc/systemd/system/$SERVICE_NAME.service"'
    expect(source).toContain(anchor)
    const body = source.replace(anchor, 'local service_file="$SANDBOX/unit.service"')
    const result = spawnSync('bash', ['-c', `${body}
SANDBOX="$1"
FAULT="$2"
DEFAULT_CONFIG="$SANDBOX/config"
INSTALL_DIR="$SANDBOX/libexec"
umask 022
id() { if [ "$1" = -u ]; then echo 0; return 0; fi; return 1; }
useradd() { [ "$FAULT" != useradd ]; }
timeout() { return 0; }
install() {
  case "$*" in
    *helper.sh*) [ "$FAULT" != helper-copy ]; ;;
    *collect-return-route.sh*) [ "$FAULT" != collector-copy ]; ;;
    *) [ "$FAULT" != directory ]; ;;
  esac
}
printf() {
  case "$1" in token=*) [ "$FAULT" != write ] || return 1;; esac
  builtin printf "$@"
}
chown() {
  # Capture the real mode before chmod can conceal an insecure creation mode.
  ${JSON.stringify(process.execPath)} -e 'console.log((require("fs").statSync(process.argv[1]).mode & 511).toString(8))' "$2" > "$SANDBOX/initial-mode"
  [ "$FAULT" != owner ]
}
chmod() { [ "$FAULT" != mode ] || return 1; command chmod "$@"; }
mv() { [ "$FAULT" != rename ] || return 1; command mv "$@"; }
systemctl() {
  printf '%s\n' "$1" >> "$SANDBOX/service-calls"
  [ "$FAULT" != "systemctl-$1" ]
}
install_helper install --endpoint https://example.invalid --token-file "$SANDBOX/agent-token"
`, helper, directory, fault], { encoding: 'utf8', timeout: 5000 })
    expect(result.stderr).not.toContain('secret-token')
    expect(result.stdout).not.toContain('secret-token')
    const files = readdirSync(directory)
    expect(files.some(file => file.includes('.tmp.'))).toBeFalse()
    return {
      ...result,
      config: files.includes('config') ? readFileSync(config, 'utf8') : null,
      mode: files.includes('config') ? statSync(config).mode & 0o777 : null,
      initialMode: files.includes('initial-mode') ? readFileSync(join(directory, 'initial-mode'), 'utf8').trim() : null,
      unit: files.includes('unit.service') ? readFileSync(unit, 'utf8') : '',
      calls: files.includes('service-calls') ? readFileSync(join(directory, 'service-calls'), 'utf8').trim().split('\n') : [],
    }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const fault of ['useradd', 'directory', 'helper-copy', 'collector-copy', 'write', 'owner', 'mode', 'rename']) {
  test(`installer aborts on ${fault}, preserves old configuration and removes temporary credentials`, () => {
    const result = execute(fault, true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('安装未完成')
    expect(result.stderr).not.toContain('已安装')
    expect(result.config).toBe('old-safe-config')
    expect(result.mode).toBe(0o640)
    expect(result.calls).toEqual([])
  })
}

for (const operation of ['daemon-reload', 'enable', 'restart', 'is-active']) {
  test(`failed systemctl ${operation} never reports installation success`, () => {
    const result = execute(`systemctl-${operation}`)
    expect(result.status).not.toBe(0)
    expect(result.stderr).not.toContain('已安装')
    expect(result.mode).toBe(0o640)
    expect(result.calls.at(-1)).toBe(operation)
  })
}

test('fresh installation with failed chmod leaves no world-readable credential file', () => {
  const result = execute('mode')
  expect(result.status).not.toBe(0)
  expect(result.initialMode).toBe('600')
  expect(result.config).toBeNull()
})

test('successful install/upgrade creates credentials as 0600, atomically promotes 0640 and restarts the service', () => {
  const result = execute('', true)
  expect(result.status, result.stderr).toBe(0)
  expect(result.initialMode).toBe('600')
  expect(result.mode).toBe(0o640)
  expect(result.config).toContain('token=secret-token')
  expect(result.calls).toEqual(['daemon-reload', 'enable', 'restart', 'is-active'])
  expect(result.unit).toContain('NoNewPrivileges=true')
  expect(result.unit).not.toContain('secret-token')
})
