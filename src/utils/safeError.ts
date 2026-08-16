const SENSITIVE_KEY = '(?:authorization|password|passwd|secret|token|cookie|api[_-]?key|access[_-]?key|session)'
const KEY_VALUE_PATTERN = new RegExp(`(\\b${SENSITIVE_KEY}\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&]+)`, 'gi')
const QUERY_VALUE_PATTERN = new RegExp(`([?&]${SENSITIVE_KEY}=)[^&#\\s]+`, 'gi')
const JSON_VALUE_PATTERN = new RegExp(`(["']${SENSITIVE_KEY}["']\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,}\\s]+)`, 'gi')
const BEARER_PATTERN = /\bBearer\s+[\w.~+/-]+=*/gi
const BASIC_PATTERN = /\bBasic\s+[\w+/]+=*/gi
const URL_CREDENTIALS_PATTERN = /(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi
const ERROR_WHITESPACE_PATTERN = /[\r\n\t]+/g
const MAX_SAFE_ERROR_MESSAGE_LENGTH = 400

export interface SafeErrorSummary {
  name: string
  message: string
  code?: number | string
}

export function redactSensitiveText(value: string): string {
  const normalized = value.replace(ERROR_WHITESPACE_PATTERN, ' ').trim()
  const redacted = normalized
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(BASIC_PATTERN, 'Basic [REDACTED]')
    .replace(URL_CREDENTIALS_PATTERN, '$1[REDACTED]@')
    .replace(QUERY_VALUE_PATTERN, '$1[REDACTED]')
    .replace(JSON_VALUE_PATTERN, '$1"[REDACTED]"')
    .replace(KEY_VALUE_PATTERN, '$1[REDACTED]')
  return redacted.length > MAX_SAFE_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH)}…`
    : redacted
}

function readPrimitiveCode(error: object): number | string | undefined {
  try {
    const code = (error as { code?: unknown }).code
    return typeof code === 'number' || typeof code === 'string'
      ? redactSensitiveText(String(code)).slice(0, 80)
      : undefined
  }
  catch {
    return undefined
  }
}

export function getSafeErrorSummary(error: unknown): SafeErrorSummary {
  try {
    if (error instanceof Error) {
      return {
        name: redactSensitiveText(error.name || 'Error').slice(0, 80),
        message: redactSensitiveText(error.message || 'Unknown error'),
        code: readPrimitiveCode(error),
      }
    }
    if (typeof error === 'string')
      return { name: 'Error', message: redactSensitiveText(error) }
    return { name: 'Error', message: 'Non-error value received' }
  }
  catch {
    return { name: 'Error', message: 'Unreadable error value' }
  }
}

export function logAppError(context: string, error: unknown): void {
  console.error(`[Transit] ${context}`, getSafeErrorSummary(error))
}

export function logAppWarning(context: string, error: unknown): void {
  console.warn(`[Transit] ${context}`, getSafeErrorSummary(error))
}
