import { describe, expect, test } from 'vitest';
import { formatPct, formatShares, formatUsdc, parseShares, parseUsdc, jsonReplacer } from '../src/lib/format.js';

describe('format helpers', () => {
  test('formatUsdc/parseUsdc roundtrip', () => {
    expect(formatUsdc(100_000_000n)).toBe('100');
    expect(formatUsdc(99_750_000n)).toBe('99.75');
    expect(parseUsdc('100')).toBe(100_000_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
  });

  test('formatShares uses 6 decimals like rmUSDC', () => {
    expect(formatShares(1_234_567n)).toBe('1.234567');
  });

  test('parseShares accepts decimals', () => {
    expect(parseShares('1.5')).toBe(1_500_000n);
  });

  test('formatPct formats rates with 2 decimals by default', () => {
    expect(formatPct(0.0361)).toBe('3.61%');
    expect(formatPct(0.05, 1)).toBe('5.0%');
  });

  test('jsonReplacer stringifies bigints', () => {
    const out = JSON.stringify({ a: 1n, b: 'x' }, jsonReplacer);
    expect(out).toBe('{"a":"1","b":"x"}');
  });
});
