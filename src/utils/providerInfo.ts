const FALLBACK_PROVIDER_MAP: Array<[RegExp, string]> = [
  [/digitalocean|do\./i, 'DigitalOcean'],
  [/vultr/i, 'Vultr'],
  [/linode|linode\.com/i, 'Linode'],
  [/aws|amazon web services|amazon.com/i, 'AWS'],
  [/azure|microsoft/i, 'Microsoft Azure'],
  [/google cloud|google/i, 'Google Cloud'],
  [/aliyun|阿里云|aliyun\.com/i, 'Alibaba Cloud'],
  [/tencent|腾讯云|tencent\.com/i, 'Tencent Cloud'],
  [/huawei|华为云|huawei\.com/i, 'Huawei Cloud'],
  [/oracle|oracle cloud/i, 'Oracle Cloud'],
  [/ovh|ovhcloud/i, 'OVH'],
  [/hetzner/i, 'Hetzner'],
  [/rackspace/i, 'Rackspace'],
  [/digital ocean/i, 'DigitalOcean'],
]

export async function fetchProviderInfo(ip: string): Promise<string> {
  if (!ip)
    return ''

  const normalizedIp = ip.trim()
  if (!normalizedIp)
    return ''

  try {
    const response = await fetch(`https://ipinfo.io/${encodeURIComponent(normalizedIp)}/json`, {
      method: 'GET',
      cache: 'no-store',
    })

    if (!response.ok)
      return ''

    const data = await response.json() as { org?: string, hostname?: string, city?: string, region?: string, country?: string }
    const org = data.org?.trim()
    if (org) {
      return org.replace(/^AS\d+\s*/i, '').trim()
    }

    return ''
  }
  catch {
    return ''
  }
}

export function detectProvider(regionStr: string): string {
  const normalized = regionStr.trim()
  if (!normalized)
    return '未知供应商'

  const lower = normalized.toLowerCase()
  for (const [pattern, provider] of FALLBACK_PROVIDER_MAP) {
    if (pattern.test(lower))
      return provider
  }

  return normalized
}
