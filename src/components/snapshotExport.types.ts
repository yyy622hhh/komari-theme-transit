export interface SnapshotRow {
  uuid: string
  name: string
  online: boolean
  group: string
  region: string
  ipv4: string
  ipv6: string
  provider: string
  asn: string
  org: string
  os: string
  arch: string
  virtualization: string
  cpuName: string
  cpuCores: number
  cpuUsage: number
  load1: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  diskUsedBytes: number
  diskTotalBytes: number
  trafficUsedBytes: number
  trafficLimitBytes: number
  trafficUsedPercent: number
  netInBytesPerSecond: number
  netOutBytesPerSecond: number
  uptimeSeconds: number
  price: number
  currency: string
  billingCycleDays: number
  monthlyCostCNY: number
  expiredAt: string | null
  tags: string
}

export interface CsvColumn {
  label: string
  value: (row: SnapshotRow) => string | number
}
