import { describe, expect, test } from 'bun:test'
import { buildSnapshotCsvAsync, buildSnapshotJsonAsync } from '../../src/services/snapshot.service'
import { escapeCsvCell, sanitizeCsvCell, toCsvRows } from '../../src/utils/csv'

describe('CSV export hardening', () => {
  test('neutralizes spreadsheet formulas hidden behind whitespace or a BOM', () => {
    expect(sanitizeCsvCell('=SUM(A1:A2)')).toBe(`'=SUM(A1:A2)`)
    expect(sanitizeCsvCell('  +cmd')).toBe(`'  +cmd`)
    expect(sanitizeCsvCell('\uFEFF@external')).toBe(`'\uFEFF@external`)
    expect(sanitizeCsvCell('ordinary text')).toBe('ordinary text')
  })

  test('quotes commas, quotes and line breaks after neutralization', () => {
    expect(escapeCsvCell('hello, "world"')).toBe('"hello, ""world"""')
    expect(toCsvRows([['name', 'value'], ['node', '=1+1']])).toBe(`name,value\r\nnode,'=1+1`)
  })

  test('cancels chunked CSV and JSON construction between browser yields', async () => {
    const rows = Array.from({ length: 4 }, (_, value) => ({ value }))
    const columns = [{ label: 'value', value: (row: { value: number }) => row.value }]

    let controller = new AbortController()
    await expect(buildSnapshotCsvAsync(
      columns,
      rows,
      async () => controller.abort(),
      2,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })

    controller = new AbortController()
    await expect(buildSnapshotJsonAsync(
      {},
      rows,
      row => row,
      async () => controller.abort(),
      2,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })
  })
})
