import type { NodeData } from '@/stores/nodes'

export type CurrencyCode = 'CNY' | 'USD' | 'HKD' | 'EUR' | 'GBP' | 'JPY' | 'RUB' | 'CHF' | 'INR' | 'VND' | 'THB' | 'CAD'
export type ExchangeRates = Record<CurrencyCode, number>
export type ExchangeRateSource = 'cache' | 'network' | 'stale-cache' | 'default'

export const DEFAULT_EXCHANGE_RATES: ExchangeRates = {
  CNY: 1,
  USD: 0.142536,
  HKD: 1.108377,
  EUR: 0.12102,
  GBP: 0.105581,
  JPY: 22.231552,
  RUB: 13.5,
  CHF: 0.12,
  INR: 11.8,
  VND: 3500,
  THB: 5.0,
  CAD: 0.19,
}

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  RUB: '₽',
  CHF: '₣',
  INR: '₹',
  VND: '₫',
  THB: '฿',
  CAD: 'CA$',
}

export function normalizeCurrency(currency: string | null | undefined): CurrencyCode {
  const value = String(currency || 'CNY').trim().toUpperCase()

  if (value === 'USD' || value === '$')
    return 'USD'
  if (value === 'HKD' || value === 'HK$')
    return 'HKD'
  if (value === 'EUR' || value === '€')
    return 'EUR'
  if (value === 'GBP' || value === '£')
    return 'GBP'
  if (value === 'JPY')
    return 'JPY'
  if (value === 'RUB' || value === '₽')
    return 'RUB'
  if (value === 'CHF' || value === '₣')
    return 'CHF'
  if (value === 'INR' || value === '₹')
    return 'INR'
  if (value === 'VND' || value === '₫')
    return 'VND'
  if (value === 'THB' || value === '฿')
    return 'THB'
  if (value === 'CAD' || value === 'CA$' || value === 'C$' || value === 'CAD$')
    return 'CAD'

  return 'CNY'
}

export function getPriceCNY(node: NodeData, exchangeRates: ExchangeRates): number {
  const price = Number(node.price)
  if (!Number.isFinite(price) || price <= 0)
    return 0

  const currency = normalizeCurrency(node.currency)
  if (currency === 'CNY')
    return price

  return price / exchangeRates[currency]
}

export function calculateMonthlyCostCNY(node: NodeData, exchangeRates: ExchangeRates): number {
  const priceCNY = getPriceCNY(node, exchangeRates)
  if (priceCNY <= 0)
    return 0

  const billingCycle = Number(node.billing_cycle)
  if (!Number.isFinite(billingCycle) || billingCycle <= 0)
    return priceCNY

  return priceCNY / billingCycle * 30
}
