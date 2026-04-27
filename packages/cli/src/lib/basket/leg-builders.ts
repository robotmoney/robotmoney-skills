import {
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { PERMIT2_ABI, USDC_ABI } from '../abi.js';
import {
  BASKET,
  DEFAULT_SLIPPAGE_BPS,
  PERMIT2,
  QUOTE_VALIDITY_MINUTES,
  UNIVERSAL_ROUTER,
} from './constants.js';
import {
  buildErc20Approve,
  buildPermit2Approve,
  encodeBasketBuy,
  encodeBasketSell,
} from './encoder.js';
import {
  readBasketHoldings,
  selectSells,
  type BasketHolding,
  type SellSelectionOptions,
} from './holdings.js';
import { applySlippage, quoteBasketBuy, quoteBasketSell } from './quoter.js';
import type { UnsignedTx } from '../simulate.js';

const MAX_U160 = (1n << 160n) - 1n;

// ---------- Buy leg ----------

export interface BuyLegResult {
  transactions: UnsignedTx[];
  details: {
    totalUsdc: string;
    totalUsdcRaw: string;
    perLegUsdc: string;
    perLegUsdcRaw: string;
    slippageBps: number;
    validUntil: number;
    quotes: Array<{
      symbol: string;
      address: Address;
      amountOut: string;
      minAmountOut: string;
      decimals: number;
    }>;
  };
}

export async function buildBasketBuyLeg(
  client: PublicClient,
  args: {
    usdc: Address; // chain USDC address (= constants.USDC)
    user: Address;
    recipient: Address;
    basketAmountRaw: bigint;
    slippageBps?: number;
  },
): Promise<BuyLegResult> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (args.basketAmountRaw === 0n) {
    throw new Error('basketAmountRaw must be > 0');
  }

  const perLegUsdc = args.basketAmountRaw / BigInt(BASKET.length);
  if (perLegUsdc === 0n) {
    throw new Error(
      `Basket per-leg amount rounds to zero (basket=${args.basketAmountRaw} / ${BASKET.length}). Increase deposit amount or pass --no-basket.`,
    );
  }

  const [usdcToPermit2, permit2ToUr, quotes] = await Promise.all([
    client.readContract({
      address: args.usdc,
      abi: USDC_ABI,
      functionName: 'allowance',
      args: [args.user, PERMIT2],
    }) as Promise<bigint>,
    client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [args.user, args.usdc, UNIVERSAL_ROUTER],
    }) as Promise<readonly [bigint, number, number]>,
    quoteBasketBuy(client, perLegUsdc),
  ]);

  const transactions: UnsignedTx[] = [];

  if (usdcToPermit2 < args.basketAmountRaw) {
    transactions.push(buildErc20Approve(args.usdc, PERMIT2, maxUint256));
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const needsPermit2Approval =
    permit2ToUr[0] < args.basketAmountRaw || BigInt(permit2ToUr[1]) < nowSec;
  if (needsPermit2Approval) {
    const expiration = nowSec + 365n * 24n * 3600n; // 1 year
    transactions.push(buildPermit2Approve(args.usdc, UNIVERSAL_ROUTER, MAX_U160, expiration));
  }

  const deadline = nowSec + BigInt(QUOTE_VALIDITY_MINUTES * 60);
  const { unsignedTx } = encodeBasketBuy({
    recipient: args.recipient,
    deadline,
    slippageBps,
    quotes,
    totalUsdc: args.basketAmountRaw,
  });
  transactions.push(unsignedTx);

  return {
    transactions,
    details: {
      totalUsdc: formatUnits(args.basketAmountRaw, 6),
      totalUsdcRaw: args.basketAmountRaw.toString(),
      perLegUsdc: formatUnits(perLegUsdc, 6),
      perLegUsdcRaw: perLegUsdc.toString(),
      slippageBps,
      validUntil: Number(deadline),
      quotes: quotes.map((q) => ({
        symbol: q.symbol,
        address: q.address,
        amountOut: q.amountOut.toString(),
        minAmountOut: applySlippage(q.amountOut, slippageBps).toString(),
        decimals: q.decimals,
      })),
    },
  };
}

// ---------- Sell leg ----------

export interface SellLegResult {
  transactions: UnsignedTx[];
  details: {
    slippageBps: number;
    validUntil: number;
    sells: Array<{
      symbol: string;
      address: Address;
      amountIn: string;
      usdcOut: string;
      minUsdcOut: string;
    }>;
  } | null; // null if no eligible balances
  holdings: BasketHolding[];
}

export interface BasketSellArgs {
  user: Address;
  recipient: Address;
  sellAll?: boolean;
  sellPercent?: number;
  sellTokens?: string[];
  // Decimal strings paired 1:1 with sellTokens. They get converted to raw via
  // each token's decimals.
  sellAmountsDecimal?: string[];
  slippageBps?: number;
}

export async function buildBasketSellLeg(
  client: PublicClient,
  args: BasketSellArgs,
): Promise<SellLegResult> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const holdings = await readBasketHoldings(client, args.user);

  const opts: SellSelectionOptions = {};
  if (args.sellAll !== undefined) opts.sellAll = args.sellAll;
  if (args.sellPercent !== undefined) opts.sellPercent = args.sellPercent;
  if (args.sellTokens) opts.sellTokens = args.sellTokens;
  if (args.sellAmountsDecimal && args.sellTokens) {
    opts.sellAmountsRaw = args.sellAmountsDecimal.map((amt, i) => {
      const sym = args.sellTokens![i]!;
      const h = holdings.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
      if (!h) throw new Error(`Unknown basket symbol: ${sym}`);
      return parseUnits(amt, h.decimals);
    });
  }

  const { inputs } = selectSells(holdings, opts);
  if (inputs.length === 0) {
    return { transactions: [], details: null, holdings };
  }

  const [quotes, ...allowanceReads] = await Promise.all([
    quoteBasketSell(client, inputs),
    ...inputs.flatMap(({ token }) => [
      client.readContract({
        address: token.address,
        abi: USDC_ABI,
        functionName: 'allowance',
        args: [args.user, PERMIT2],
      }),
      client.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [args.user, token.address, UNIVERSAL_ROUTER],
      }),
    ]),
  ]);

  const transactions: UnsignedTx[] = [];
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expiration = nowSec + 365n * 24n * 3600n;

  for (let i = 0; i < inputs.length; i++) {
    const { token, amountIn } = inputs[i]!;
    const tokenToPermit2 = allowanceReads[i * 2] as bigint;
    const permit2ToUr = allowanceReads[i * 2 + 1] as readonly [bigint, number, number];

    if (tokenToPermit2 < amountIn) {
      transactions.push(buildErc20Approve(token.address, PERMIT2, maxUint256));
    }
    if (permit2ToUr[0] < amountIn || BigInt(permit2ToUr[1]) < nowSec) {
      transactions.push(buildPermit2Approve(token.address, UNIVERSAL_ROUTER, MAX_U160, expiration));
    }
  }

  const deadline = nowSec + BigInt(QUOTE_VALIDITY_MINUTES * 60);
  const sellInputs = inputs.map((input, i) => ({
    token: input.token,
    amountIn: input.amountIn,
    minUsdcOut: applySlippage(quotes[i]!.amountOut, slippageBps),
  }));
  transactions.push(encodeBasketSell(sellInputs, args.recipient, deadline));

  return {
    transactions,
    details: {
      slippageBps,
      validUntil: Number(deadline),
      sells: inputs.map((input, i) => ({
        symbol: input.token.symbol,
        address: input.token.address,
        amountIn: input.amountIn.toString(),
        usdcOut: quotes[i]!.amountOut.toString(),
        minUsdcOut: applySlippage(quotes[i]!.amountOut, slippageBps).toString(),
      })),
    },
    holdings,
  };
}
