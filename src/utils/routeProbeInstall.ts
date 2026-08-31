function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Production commands never silently downgrade transport or reuse the caller's files. */
export function buildRouteProbeInstallCommand(endpoint: string, release: string): string {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password)
      return ''
  }
  catch {
    return ''
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/i.test(release))
    return ''
  const base = `https://github.com/yyy622hhh/komari-theme-transit/releases/download/${release}`
  return [
    '(',
    '  set -eu',
    '  umask 077',
    '  transit_install_dir=$(mktemp -d /tmp/transit-route-probe-install.XXXXXX) || exit 1',
    '  trap \'transit_install_status=$?; rm -f -- "$transit_install_dir/transit-route-probe-helper.sh" "$transit_install_dir/collect-return-route.sh"; rmdir -- "$transit_install_dir"; exit "$transit_install_status"\' EXIT',
    '  cd "$transit_install_dir" || exit 1',
    `  curl -q --proto '=https' --proto-redir '=https' -fsSL ${base}/transit-route-probe-helper.sh -o transit-route-probe-helper.sh || exit 1`,
    `  curl -q --proto '=https' --proto-redir '=https' -fsSL ${base}/transit-collect-return-route.sh -o collect-return-route.sh || exit 1`,
    `  sudo bash "$transit_install_dir/transit-route-probe-helper.sh" install --endpoint ${shellSingleQuote(endpoint)}`,
    ')',
  ].join('\n')
}
