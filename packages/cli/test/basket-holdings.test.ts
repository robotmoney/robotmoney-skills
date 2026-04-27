import { describe, expect, test } from 'vitest';
import { selectSells, type BasketHolding } from '../src/lib/basket/holdings.js';
import { BASKET } from '../src/lib/basket/constants.js';

const mkHolding = (symbol: string, balanceRaw: bigint): BasketHolding => {
  const cfg = BASKET.find((t) => t.symbol === symbol);
  if (!cfg) throw new Error(`unknown symbol: ${symbol}`);
  return {
    symbol,
    address: cfg.address,
    decimals: cfg.decimals,
    balanceRaw,
    config: cfg,
  };
};

const HOLDINGS: BasketHolding[] = [
  mkHolding('VIRTUAL', 1_000_000_000_000_000_000n), // 1.0 VIRTUAL
  mkHolding('ROBOT', 100_000_000_000_000_000_000n), // 100 ROBOT
  mkHolding('BNKR', 0n),
  mkHolding('JUNO', 5_000_000_000_000_000_000n), // 5 JUNO
  mkHolding('ZFI', 0n),
  mkHolding('GIZA', 0n),
];

describe('selectSells', () => {
  test('--sell-all picks every non-zero holding', () => {
    const { inputs } = selectSells(HOLDINGS, { sellAll: true });
    expect(inputs.map((i) => i.token.symbol)).toEqual(['VIRTUAL', 'ROBOT', 'JUNO']);
    expect(inputs[0]!.amountIn).toBe(1_000_000_000_000_000_000n);
    expect(inputs[1]!.amountIn).toBe(100_000_000_000_000_000_000n);
    expect(inputs[2]!.amountIn).toBe(5_000_000_000_000_000_000n);
  });

  test('--sell-percent computes pro-rata', () => {
    const { inputs } = selectSells(HOLDINGS, { sellPercent: 50 });
    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.amountIn).toBe(500_000_000_000_000_000n);
    expect(inputs[1]!.amountIn).toBe(50_000_000_000_000_000_000n);
    expect(inputs[2]!.amountIn).toBe(2_500_000_000_000_000_000n);
  });

  test('--sell-tokens scopes to specified symbols', () => {
    const { inputs } = selectSells(HOLDINGS, { sellTokens: ['VIRTUAL', 'JUNO'] });
    expect(inputs.map((i) => i.token.symbol)).toEqual(['VIRTUAL', 'JUNO']);
    // No percent or amount specified: defaults to selling full balance.
    expect(inputs[0]!.amountIn).toBe(1_000_000_000_000_000_000n);
    expect(inputs[1]!.amountIn).toBe(5_000_000_000_000_000_000n);
  });

  test('--sell-tokens + --sell-percent combines correctly', () => {
    const { inputs } = selectSells(HOLDINGS, {
      sellTokens: ['ROBOT'],
      sellPercent: 25,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.token.symbol).toBe('ROBOT');
    expect(inputs[0]!.amountIn).toBe(25_000_000_000_000_000_000n);
  });

  test('--sell-amounts pairs 1:1 with --sell-tokens', () => {
    const { inputs } = selectSells(HOLDINGS, {
      sellTokens: ['VIRTUAL', 'JUNO'],
      sellAmountsRaw: [500_000_000_000_000_000n, 1_000_000_000_000_000_000n],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.amountIn).toBe(500_000_000_000_000_000n);
    expect(inputs[1]!.amountIn).toBe(1_000_000_000_000_000_000n);
  });

  test('zero balances are filtered out', () => {
    const { inputs } = selectSells(HOLDINGS, { sellAll: true });
    expect(inputs.find((i) => i.token.symbol === 'BNKR')).toBeUndefined();
    expect(inputs.find((i) => i.token.symbol === 'ZFI')).toBeUndefined();
    expect(inputs.find((i) => i.token.symbol === 'GIZA')).toBeUndefined();
  });

  test('throws on unknown symbol', () => {
    expect(() =>
      selectSells(HOLDINGS, { sellTokens: ['NOPE', 'VIRTUAL'] }),
    ).toThrow(/unknown basket symbol/i);
  });

  test('throws when amount exceeds balance', () => {
    expect(() =>
      selectSells(HOLDINGS, {
        sellTokens: ['VIRTUAL'],
        sellAmountsRaw: [10_000_000_000_000_000_000n], // 10x what user holds
      }),
    ).toThrow(/exceeds balance/i);
  });

  test('throws when percent out of range', () => {
    expect(() => selectSells(HOLDINGS, { sellPercent: 0 })).toThrow(/in \[1, 100\]/);
    expect(() => selectSells(HOLDINGS, { sellPercent: 101 })).toThrow(/in \[1, 100\]/);
  });

  test('throws on mutually exclusive --sell-all + --sell-percent', () => {
    expect(() =>
      selectSells(HOLDINGS, { sellAll: true, sellPercent: 50 }),
    ).toThrow(/mutually exclusive/i);
  });

  test('throws when --sell-amounts mismatched with --sell-tokens', () => {
    expect(() =>
      selectSells(HOLDINGS, {
        sellTokens: ['VIRTUAL'],
        sellAmountsRaw: [1n, 2n],
      }),
    ).toThrow(/pair 1:1/);
  });
});
