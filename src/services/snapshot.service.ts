import { toCsvRows } from '@/utils/csv'

const UTF8_BOM = String.fromCharCode(0xFEFF)

export interface SnapshotCsvColumn<T> {
  label: string
  value: (row: T) => string | number
}

export function buildSnapshotCsv<T>(columns: Array<SnapshotCsvColumn<T>>, rows: T[]): string {
  return toCsvRows([
    columns.map(column => column.label),
    ...rows.map(row => columns.map(column => column.value(row))),
  ])
}

export function downloadText(filename: string, content: string, type: string, options?: { bom?: boolean }): void {
  const blob = new Blob([options?.bom ? UTF8_BOM : '', content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
