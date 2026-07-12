const CSV_ESCAPE_NEEDED_REGEX = /[",\n\r]/
const CSV_QUOTE_REGEX = /"/g
const CSV_LINE_BREAK_REGEX = /\r?\n/g
const CSV_FORMULA_INJECTION_REGEX = /^[\t\r ]*[=+\-@]/

export function sanitizeCsvValue(value: unknown): string {
  const text = String(value ?? '').replace(CSV_LINE_BREAK_REGEX, ' / ')
  return CSV_FORMULA_INJECTION_REGEX.test(text) ? `'${text}` : text
}

export function escapeCsvCell(value: unknown): string {
  const text = sanitizeCsvValue(value)
  if (CSV_ESCAPE_NEEDED_REGEX.test(text))
    return `"${text.replace(CSV_QUOTE_REGEX, '""')}"`
  return text
}

export function toCsvRows(rows: Array<Array<unknown>>): string {
  return rows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n')
}
