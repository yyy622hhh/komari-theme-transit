import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, test } from 'bun:test'

const helper = resolve('scripts/transit-route-probe-helper.sh')
function execute(body: string) {
  const directory = mkdtempSync(`${tmpdir()}/transit-shell-test-`)
  try {
    const result = spawnSync('bash', ['-s', helper, directory], { encoding: 'utf8', input: `source "$1"\nRUNTIME_DIRECTORY="$2"\n${body}`, timeout: 5000 })
    expect(result.stderr).not.toContain('secret-token')
    expect(result.status, result.stderr).toBe(0)
    return result
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('executes jitter ranges without waiting or privileged setup', () => {
  const result = execute(`for base in 15 30 60 120 300; do
    for i in {1..80}; do printf '%s %s\n' "$base" "$(jittered_backoff "$base")"; done
  done
  for i in {1..80}; do printf '0 %s\n' "$(random_between 12 18)"; done`)
  for (const line of result.stdout.trim().split('\n')) {
    const [base, value] = line.split(' ').map(Number) as [number, number]
    expect(value).toBeGreaterThanOrEqual(base ? base * 0.8 : 12)
    expect(value).toBeLessThanOrEqual(base ? base * 1.2 : 18)
  }
})

test('executes HTTP polling, exponential backoff, success reset, Retry-After and log suppression', () => {
  const result = execute(`
read_config() { ENDPOINT=https://example.invalid; TOKEN=secret-token; }
timeout() { return 0; }
curl() {
  local headers='' output=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --dump-header) headers="$2"; shift;; --output) output="$2"; shift;; esac
    shift
  done
  printf 'Retry-After: %s\r\n' "$HTTP_RETRY" > "$headers"
  printf '\n' > "$output"
  [ "$HTTP_STATUS" != network ] || return 1
  printf '%s' "$HTTP_STATUS"
}
statuses=(network 503 503 500 500 500 204 503 401 401 403 404 204 503 204 200 503)
retries=('' '' '' '' '' '' '' '' '' '' '' '' '' 47 999999 '' '')
index=0
eval "$(declare -f poll_once | sed '1s/poll_once/real_poll_once/')"
poll_once() {
  [ "$index" -lt "\${#statuses[@]}" ] || exit 0
  HTTP_STATUS="\${statuses[$index]}"
  HTTP_RETRY="\${retries[$index]}"
  index=$((index + 1))
  real_poll_once "$1"
}
sleep() { printf '%s\n' "$1"; }
run_loop ignored
`)
  const delays = result.stdout.trim().split('\n').map(Number)
  expect(delays).toHaveLength(17)
  const bases = [15, 30, 60, 120, 300, 300, 0, 15, 300, 300, 300, 300, 0, 47, 0, 0, 15]
  delays.forEach((value, index) => {
    const base = bases[index]!
    if ((index >= 8 && index <= 11) || index === 13) {
      expect(value).toBe(base)
    }
    else {
      expect(value).toBeGreaterThanOrEqual(base ? base * 0.8 : 12)
      expect(value).toBeLessThanOrEqual(base ? base * 1.2 : 18)
    }
  })
  expect(result.stderr.match(/HTTP 401/g)).toHaveLength(1)
  expect(result.stderr.match(/HTTP 500/g)).toHaveLength(1)
})
