import { describe, expect, it } from 'vitest';
import { formatMoney, fromCents, sumMoney, toCents } from './money';

describe('money', () => {
  it('toCents handles strings and rounds at 2dp', () => {
    expect(toCents('0')).toBe(0);
    expect(toCents('1')).toBe(100);
    expect(toCents('1.00')).toBe(100);
    expect(toCents('1.5')).toBe(150);
    expect(toCents('1.234')).toBe(123); // truncates additional fraction
    expect(toCents('1,234.50')).toBe(123450);
    expect(toCents('-3.21')).toBe(-321);
    expect(toCents(null)).toBe(0);
    expect(toCents('')).toBe(0);
  });

  it('fromCents formats with two decimals', () => {
    expect(fromCents(0)).toBe('0.00');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(123450)).toBe('1234.50');
    expect(fromCents(-321)).toBe('-3.21');
  });

  it('sumMoney is exact across many values (no float drift)', () => {
    // 1000 × $0.10 = $100.00. Internally summed in cents, then converted.
    expect(sumMoney(Array.from({ length: 1000 }, () => '0.10'))).toBe(100);
    expect(sumMoney(['12.34', '56.78', '0.01'])).toBe(69.13);
  });

  it('formatMoney treats input as dollars (numbers + decimal strings)', () => {
    expect(formatMoney('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatMoney('0', 'USD', 'en-US')).toBe('$0.00');
    // Critically: whole-dollar amounts as numbers must format as dollars,
    // not as cents. (Regression: previously $500 rendered as $5.00.)
    expect(formatMoney(500, 'USD', 'en-US')).toBe('$500.00');
    expect(formatMoney(12.5, 'USD', 'en-US')).toBe('$12.50');
    expect(formatMoney(0, 'USD', 'en-US')).toBe('$0.00');
  });
});
