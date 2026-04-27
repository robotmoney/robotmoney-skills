import type { Address, PublicClient } from 'viem';
import { USDC_ABI } from '../abi.js';
import { BASKET, type BasketTokenConfig } from './constants.js';

export interface BasketHolding {
  symbol: string;
  address: Address;
  decimals: number;
  balanceRaw: bigint;
  config: BasketTokenConfig;
}

// Reads the user's balance of every basket token in parallel. Caller can
// follow-up with quoter to get USD valuations.
export async function readBasketHoldings(
  client: PublicClient,
  user: Address,
): Promise<BasketHolding[]> {
  const balances = (await Promise.all(
    BASKET.map((token) =>
      client.readContract({
        address: token.address,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [user],
      }),
    ),
  )) as bigint[];

  return BASKET.map((token, i) => ({
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
    balanceRaw: balances[i]!,
    config: token,
  }));
}

export interface SellSelection {
  // Tokens with non-zero amountIn to sell. Tokens with zero are excluded.
  inputs: Array<{ token: BasketTokenConfig; amountIn: bigint }>;
}

export interface SellSelectionOptions {
  sellAll?: boolean;
  sellPercent?: number; // 1..100
  sellTokens?: string[]; // symbols
  sellAmountsRaw?: bigint[]; // parallel to sellTokens, raw units
}

export function selectSells(
  holdings: readonly BasketHolding[],
  opts: SellSelectionOptions,
): SellSelection {
  const { sellAll, sellPercent, sellTokens, sellAmountsRaw } = opts;

  if (sellAll && sellPercent !== undefined) {
    throw new Error('--sell-all and --sell-percent are mutually exclusive');
  }
  if (sellAmountsRaw && (!sellTokens || sellAmountsRaw.length !== sellTokens.length)) {
    throw new Error('--sell-amounts must pair 1:1 with --sell-tokens');
  }
  if (sellPercent !== undefined && (sellPercent < 1 || sellPercent > 100)) {
    throw new Error('--sell-percent must be in [1, 100]');
  }

  // Resolve scope: which holdings are eligible
  let scope: BasketHolding[];
  if (sellTokens && sellTokens.length > 0) {
    const wanted = new Set(sellTokens.map((s) => s.toUpperCase()));
    scope = holdings.filter((h) => wanted.has(h.symbol.toUpperCase()));
    const missing = [...wanted].filter(
      (sym) => !holdings.some((h) => h.symbol.toUpperCase() === sym),
    );
    if (missing.length > 0) {
      throw new Error(`Unknown basket symbol(s): ${missing.join(', ')}`);
    }
  } else {
    scope = [...holdings];
  }

  const inputs: Array<{ token: BasketTokenConfig; amountIn: bigint }> = [];
  for (let i = 0; i < scope.length; i++) {
    const h = scope[i]!;
    let amountIn: bigint;
    if (sellAmountsRaw && sellTokens) {
      // Find this holding's index in the sellTokens list
      const idx = sellTokens.findIndex(
        (s) => s.toUpperCase() === h.symbol.toUpperCase(),
      );
      amountIn = sellAmountsRaw[idx]!;
    } else if (sellPercent !== undefined) {
      amountIn = (h.balanceRaw * BigInt(sellPercent)) / 100n;
    } else if (sellAll || (sellTokens && sellTokens.length > 0)) {
      // sellTokens without amounts/percent means "sell all of these"
      amountIn = h.balanceRaw;
    } else {
      amountIn = 0n;
    }
    if (amountIn > h.balanceRaw) {
      throw new Error(
        `${h.symbol}: requested ${amountIn} exceeds balance ${h.balanceRaw}`,
      );
    }
    if (amountIn > 0n) {
      inputs.push({ token: h.config, amountIn });
    }
  }
  return { inputs };
}
