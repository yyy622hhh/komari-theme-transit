export function maskIpAddress(value: string | null | undefined): string {
  const ip = value?.trim()
  if (!ip)
    return '-'

  if (ip.includes('.')) {
    const octets = ip.split('.')
    if (octets.length === 4)
      return `${octets[0]}.${octets[1]}.*.*`
  }

  if (ip.includes(':')) {
    const sections = ip.split(':').filter(Boolean)
    return `${sections.slice(0, 2).join(':') || '****'}:****:****`
  }

  if (ip.length <= 6)
    return '******'

  return `${ip.slice(0, 3)}***${ip.slice(-2)}`
}

export function formatPrivateValue(value: string | null | undefined, privacyMode: boolean): string {
  const normalized = value?.trim()
  if (!normalized)
    return '-'
  return privacyMode ? maskIpAddress(normalized) : normalized
}
