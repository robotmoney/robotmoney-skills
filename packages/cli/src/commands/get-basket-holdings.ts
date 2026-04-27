import { formatUnits, type Address } from 'viem';
import { readBasketHoldings } from '../lib/basket/holdings.js';
import { quoteBasketSell } from '../lib/basket/quoter.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatUsdc } from '../lib/format.js';
import type { GlobalFlags } from '../lib/args.js';

export interface GetBasketHoldingsOptions {
  userAddress: Address;
  // Skip USD valuation (faster, no quoter calls).
  noPricing?: boolean;
}

export async function getBasketHoldings(
  flags: GlobalFlags,
  options: GetBasketHoldingsOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);

  const holdings = await readBasketHoldings(client, options.userAddress);

  // Quote each non-zero balance to USDC for valuation. We quote sell-side at the
  // user's actual balance, which is the most honest mark-to-market.
  let valuations: Map<Address, bigint> = new Map();
  if (!options.noPricing) {
    const sellInputs = holdings
      .filter((h) => h.balanceRaw > 0n)
      .map((h) => ({ token: h.config, amountIn: h.balanceRaw }));
    if (sellInputs.length > 0) {
      try {
        const quotes = await quoteBasketSell(client, sellInputs);
        for (let i = 0; i < sellInputs.length; i++) {
          valuations.set(sellInputs[i]!.token.address, quotes[i]!.amountOut);
        }
      } catch {
        // Pricing best-effort — empty map means we just don't show usdValue.
        valuations = new Map();
      }
    }
  }

  let totalUsdcRaw = 0n;
  const items = holdings.map((h) => {
    const usdcRaw = valuations.get(h.address);
    if (usdcRaw !== undefined) totalUsdcRaw += usdcRaw;
    return {
      symbol: h.symbol,
      address: h.address,
      decimals: h.decimals,
      balance: formatUnits(h.balanceRaw, h.decimals),
      balanceRaw: h.balanceRaw.toString(),
      ...(usdcRaw !== undefined
        ? {
            usdValue: formatUsdc(usdcRaw),
            usdValueRaw: usdcRaw.toString(),
          }
        : {}),
    };
  });

  emitJson(
    {
      user: options.userAddress,
      holdings: items,
      ...(valuations.size > 0
        ? {
            totalUsdValue: formatUsdc(totalUsdcRaw),
            totalUsdValueRaw: totalUsdcRaw.toString(),
          }
        : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
