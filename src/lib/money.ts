import { config } from './config';

/**
 * Money is stored in Postgres as numeric(14,2) and arrives in JS as a string
 * (e.g. "1234.50"). All *public* APIs in this module use DOLLARS as their unit
 * (either a number like 1234.50, or a decimal string like "1234.50"). We use
 * cents internally only to sidestep float drift when summing many values.
 *
 *  - sumMoney([...])       → dollars (number)
 *  - formatMoney(dollars)  → "$1,234.50"
 *  - formatMoneyCompact()  → "$1.2k"
 */

export type MoneyInput = string | number | null | undefined;

/** Parse a money input into integer cents. Used internally to sum safely. */
export function toCents(value: MoneyInput): number {
  if (value === null || value === undefined || value === '') return 0;
  const s = typeof value === 'number' ? value.toFixed(2) : value;
  const [whole, frac = ''] = s.replace(/[, ]/g, '').split('.');
  const sign = whole?.startsWith('-') ? -1 : 1;
  const w = (whole ?? '0').replace('-', '');
  const f = (frac + '00').slice(0, 2);
  return sign * (parseInt(w || '0', 10) * 100 + parseInt(f || '0', 10));
}

/** Format cents as "1234.50" (raw, no currency symbol). */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

/** Sum a list of money inputs and return the total as DOLLARS (number). */
export function sumMoney(values: MoneyInput[]): number {
  const cents = values.reduce<number>((acc, v) => acc + toCents(v), 0);
  return cents / 100;
}

function toDollars(value: MoneyInput | number): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  // It's a string — parse via cents so "1,234.50" / "1234.50" both work and we
  // never go through a lossy float intermediate.
  return toCents(value) / 100;
}

/** Format a dollar amount as currency, e.g. 1234.5 → "$1,234.50". */
export function formatMoney(
  value: MoneyInput | number,
  currency: string = config.baseCurrency,
  locale: string = config.baseLocale,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toDollars(value));
}

/** Compact form: 1234.5 → "$1.2K", 1_500_000 → "$1.5M". Input is dollars. */
export function formatMoneyCompact(
  value: MoneyInput | number,
  currency: string = config.baseCurrency,
  locale: string = config.baseLocale,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(toDollars(value));
}
