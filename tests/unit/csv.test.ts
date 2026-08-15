import { describe, expect, test } from 'bun:test'
import { escapeCsvCell, sanitizeCsvCell, toCsvRows } from '../../src/utils/csv'

describe('CSV export hardening', () => {
  test('neutralizes spreadsheet formulas hidden behind whitespace or a BOM', () => {
    expect(sanitizeCsvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(sanitizeCsvCell('  +cmd')).toBe("'  +cmd")
    expect(sanitizeCsvCell('\uFEFF@external')).toBe("'\uFEFF@external")
    expect(sanitizeCsvCell('ordinary text')).toBe('ordinary text')
  })

  test('quotes commas, quotes and line breaks after neutralization', () => {
    expect(escapeCsvCell('hello, "world"')).toBe('"hello, ""world"""')
    expect(toCsvRows([['name', 'value'], ['node', '=1+1']])).toBe("name,value\r\nnode,'=1+1")
  })
})
