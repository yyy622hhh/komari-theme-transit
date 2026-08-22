import { describe, expect, test } from 'bun:test'
import { buildSnapshotCsvAsync, buildSnapshotJsonAsync, downloadText } from '../../src/services/snapshot.service'
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

  test('keeps an object URL alive until the browser has consumed the download click', async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let revoked = false
    let revokedAtClick = true
    const link = {
      click: () => {
        revokedAtClick = revoked
      },
      download: '',
      href: '',
      remove: () => {},
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: () => {} },
        createElement: () => link,
      },
    })
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {
      revoked = true
    }

    try {
      downloadText('snapshot.csv', 'value', 'text/csv')
      expect(revokedAtClick).toBe(false)
      expect(revoked).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(revoked).toBe(true)
    }
    finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      if (originalDocument)
        Object.defineProperty(globalThis, 'document', originalDocument)
      else
        Reflect.deleteProperty(globalThis, 'document')
    }
  })
})
