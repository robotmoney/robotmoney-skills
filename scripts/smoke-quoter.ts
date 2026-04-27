#!/usr/bin/env tsx
/** Smoke test: quote $5 USDC -> each basket token, then sell back $1 worth of each. */
import { createPublicClient, fallback, http } from 'viem';
import { base } from 'viem/chains';
import { BASKET, USDC } from '../packages/cli/src/lib/basket/constants.js';
import {
  applySlippage,
  quoteBasketBuy,
  quoteBasketSell,
} from '../packages/cli/src/lib/basket/quoter.js';

async function main() {
  const client = createPublicClient({
    chain: base,
    transport: fallback([
      http('https://base.drpc.org', { timeout: 20_000 }),
      http('https://mainnet.base.org', { timeout: 20_000 }),
      http('https://base-rpc.publicnode.com', { timeout: 20_000 }),
    ]),
  });

  console.log('=== BUY: $5 USDC -> each token ===');
  const buyQuotes = await quoteBasketBuy(client, 5_000_000n);
  for (const q of buyQuotes) {
    const min = applySlippage(q.amountOut, 300); // 3% slippage
    console.log(
      `  ${q.symbol.padEnd(8)} amountOut=${q.amountOut.toString().padEnd(28)} minOut(3%)=${min}`,
    );
  }

  console.log('\n=== SELL: 1% of each amountOut back to USDC ===');
  const sellInputs = BASKET.map((t, i) => ({
    token: t,
    amountIn: buyQuotes[i]!.amountOut / 100n, // sell 1% of what we'd have bought
  }));
  const sellQuotes = await quoteBasketSell(client, sellInputs);
  for (const q of sellQuotes) {
    const min = applySlippage(q.amountOut, 300);
    console.log(
      `  ${BASKET[sellQuotes.indexOf(q)]!.symbol.padEnd(8)} usdcOut=${q.amountOut.toString().padEnd(12)} minOut(3%)=${min}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
