import type { Address, Hex, PublicClient } from 'viem';
import {
  BASKET,
  USDC,
  V3_QUOTER_V2,
  V4_QUOTER,
  type BasketTokenConfig,
  type SingleHopPool,
} from './constants.js';

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export interface BasketQuote {
  symbol: string;
  address: Address;
  amountOut: bigint;
  decimals: number;
  // For mixed-path tokens (e.g. ROBOT V3->V4): the per-hop output amounts.
  // hopOutputs[i] is the output of hop i in the path. For purely-V3 single
  // multihop quotes this is undefined (the V3 quoter doesn't expose it).
  hopOutputs?: bigint[];
}

export function encodeV3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length !== fees.length + 1) {
    throw new Error(`v3 path length mismatch: ${tokens.length} tokens vs ${fees.length} fees`);
  }
  let out = '0x';
  for (let i = 0; i < fees.length; i++) {
    out += tokens[i]!.slice(2).toLowerCase();
    out += fees[i]!.toString(16).padStart(6, '0');
  }
  out += tokens[tokens.length - 1]!.slice(2).toLowerCase();
  return out as Hex;
}

function sortPair(a: Address, b: Address): { c0: Address; c1: Address; aIsZero: boolean } {
  const aIsZero = a.toLowerCase() < b.toLowerCase();
  return aIsZero ? { c0: a, c1: b, aIsZero: true } : { c0: b, c1: a, aIsZero: false };
}

async function quoteV3Multihop(
  client: PublicClient,
  tokens: readonly Address[],
  fees: readonly number[],
  amountIn: bigint,
): Promise<bigint> {
  const path = encodeV3Path(tokens, fees);
  const sim = (await client.simulateContract({
    address: V3_QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInput',
    args: [path, amountIn],
  })) as { result: readonly [bigint, readonly bigint[], readonly number[], bigint] };
  return sim.result[0];
}

async function quoteV4Single(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  hop: Extract<SingleHopPool, { version: 'v4' }>,
  amountIn: bigint,
): Promise<bigint> {
  const { c0, c1, aIsZero } = sortPair(tokenIn, tokenOut);
  const sim = (await client.simulateContract({
    address: V4_QUOTER,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey: {
          currency0: c0,
          currency1: c1,
          fee: hop.fee,
          tickSpacing: hop.tickSpacing,
          hooks: hop.hooks,
        },
        zeroForOne: aIsZero,
        exactAmount: amountIn,
        hookData: '0x',
      },
    ],
  })) as { result: readonly [bigint, bigint] };
  return sim.result[0];
}

// Quote a chained path. Returns final amountOut and per-segment-boundary
// outputs. Consecutive V3 hops fold into one quoter call; V4 hops are quoted
// singly. hopOutputs[i] is the running amount AFTER hop i (so the last entry
// equals the final amountOut).
async function quoteChainedExactIn(
  client: PublicClient,
  pathTokens: readonly Address[],
  hops: readonly SingleHopPool[],
  amountIn: bigint,
): Promise<{ finalOut: bigint; hopOutputs: bigint[] }> {
  const hopOutputs: bigint[] = new Array(hops.length).fill(0n);
  let amount = amountIn;
  let i = 0;
  while (i < hops.length) {
    const hop = hops[i]!;
    if (hop.version === 'v3') {
      let j = i;
      while (j < hops.length && hops[j]!.version === 'v3') j++;
      const segmentTokens = pathTokens.slice(i, j + 1);
      const segmentFees = hops.slice(i, j).map((h) => (h as Extract<SingleHopPool, { version: 'v3' }>).fee);
      amount = await quoteV3Multihop(client, segmentTokens, segmentFees, amount);
      // We don't have intermediate per-V3-hop amounts from QuoterV2; record the
      // segment's combined output at its last hop position. Mid-segment entries
      // stay 0n (callers should treat 0 as "unknown intermediate").
      hopOutputs[j - 1] = amount;
      i = j;
    } else {
      const tokenIn = pathTokens[i]!;
      const tokenOut = pathTokens[i + 1]!;
      amount = await quoteV4Single(client, tokenIn, tokenOut, hop, amount);
      hopOutputs[i] = amount;
      i++;
    }
  }
  return { finalOut: amount, hopOutputs };
}

export async function quoteBasketBuy(
  client: PublicClient,
  usdcPerLeg: bigint,
  tokens: readonly BasketTokenConfig[] = BASKET,
): Promise<BasketQuote[]> {
  return Promise.all(
    tokens.map(async (token): Promise<BasketQuote> => {
      if (!token.pathTokens || !token.hops) {
        throw new Error(`Token ${token.symbol} missing pool routing`);
      }
      const { finalOut, hopOutputs } = await quoteChainedExactIn(
        client,
        token.pathTokens,
        token.hops,
        usdcPerLeg,
      );
      return {
        symbol: token.symbol,
        address: token.address,
        amountOut: finalOut,
        decimals: token.decimals,
        hopOutputs,
      };
    }),
  );
}

export interface BasketSellInput {
  token: BasketTokenConfig;
  amountIn: bigint;
}

// Sell quote — reverse the path: token -> ... -> USDC.
export async function quoteBasketSell(
  client: PublicClient,
  inputs: readonly BasketSellInput[],
): Promise<BasketQuote[]> {
  return Promise.all(
    inputs.map(async ({ token, amountIn }): Promise<BasketQuote> => {
      if (!token.pathTokens || !token.hops) {
        throw new Error(`Token ${token.symbol} missing pool routing`);
      }
      const reverseTokens = [...token.pathTokens].reverse();
      const reverseHops = [...token.hops].reverse();
      const { finalOut, hopOutputs } = await quoteChainedExactIn(
        client,
        reverseTokens,
        reverseHops,
        amountIn,
      );
      return {
        symbol: token.symbol,
        address: USDC,
        amountOut: finalOut,
        decimals: 6,
        hopOutputs,
      };
    }),
  );
}

// Apply slippage tolerance to an expected amountOut.
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be in [0, 10000], got ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
