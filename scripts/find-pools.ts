#!/usr/bin/env tsx
/**
 * Discover the deepest Uniswap pool per basket token, on Base mainnet.
 *
 * Two passes per token:
 *   1. Dexscreener API — fast, surfaces V3 + V4 pools with liquidity numbers.
 *   2. On-chain — verify the V3 fee tier or pull V4 PoolKey fields the API
 *      doesn't give us (hooks, tickSpacing).
 *
 * Output: a TypeScript snippet ready to paste into constants.ts. The script
 * does NOT mutate constants.ts — review the output, then commit by hand.
 *
 * Run: pnpm --filter @robotmoney/cli exec tsx ../../scripts/find-pools.ts
 */
import {
  createPublicClient,
  encodeAbiParameters,
  fallback,
  http,
  getAddress,
  keccak256,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import {
  BASKET,
  USDC,
  WETH,
  V3_FACTORY,
  V3_QUOTER_V2,
  V4_POOL_MANAGER,
} from '../packages/cli/src/lib/basket/constants.js';

// ---------- ABIs (minimal slices) ----------

const V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const V3_POOL_ABI = [
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

// ---------- Config ----------

const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

// V4 PoolManager.Initialize event — emits the full PoolKey when a pool is created.
const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

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

// Known V4 hook candidates to brute-force against pool IDs.
const HOOK_CANDIDATES: Array<{ label: string; address: Address }> = [
  { label: 'Clanker DynamicFee v4.1.0 (V2)', address: '0xd60D6B218116cFd801E28F78d011a203D2b068Cc' },
  { label: 'Clanker DynamicFee v4.0.0', address: '0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC' },
  { label: 'Clanker StaticFee v4.1.0 (V2)', address: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC' },
  { label: 'Clanker StaticFee v4.0.0', address: '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC' },
  { label: 'Doppler RehypeDopplerHook', address: '0x3ec4798a9b11e8243a8db99687f7a23597b96623' },
  { label: 'NoHook', address: zeroAddress },
];

const FEE_CANDIDATES = [0x800000, 100, 500, 3000, 10000, 0] as const;
const TICK_SPACING_CANDIDATES = [200, 100, 60, 10, 1] as const;

function computePoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [{ currency0, currency1, fee, tickSpacing, hooks }],
    ),
  );
}

function bruteForcePoolKey(
  poolId: Hex,
  tokenA: Address,
  tokenB: Address,
): { fee: number; tickSpacing: number; hooks: Address; hookLabel: string } | null {
  // V4 PoolKey requires currency0 < currency1 (sorted).
  const [c0, c1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  for (const hook of HOOK_CANDIDATES) {
    for (const fee of FEE_CANDIDATES) {
      for (const tickSpacing of TICK_SPACING_CANDIDATES) {
        const id = computePoolId(c0, c1, fee, tickSpacing, hook.address);
        if (id.toLowerCase() === poolId.toLowerCase()) {
          return { fee, tickSpacing, hooks: hook.address, hookLabel: hook.label };
        }
      }
    }
  }
  return null;
}

// Encode a Uniswap V3 path: token0 | fee0 (3 bytes) | token1 | fee1 (3 bytes) | token2 ...
function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1) throw new Error('path length mismatch');
  let out = '0x';
  for (let i = 0; i < fees.length; i++) {
    out += tokens[i]!.slice(2).toLowerCase();
    out += fees[i]!.toString(16).padStart(6, '0');
  }
  out += tokens[tokens.length - 1]!.slice(2).toLowerCase();
  return out as Hex;
}

async function quoteV3(
  client: ReturnType<typeof createPublicClient>,
  tokens: Address[],
  fees: number[],
  amountInRaw: bigint,
): Promise<bigint | null> {
  const path = encodeV3Path(tokens, fees);
  try {
    const result = (await client.simulateContract({
      address: V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInput',
      args: [path, amountInRaw],
    })) as { result: readonly [bigint, readonly bigint[], readonly number[], bigint] };
    return result.result[0];
  } catch {
    return null;
  }
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  labels?: string[]; // e.g. ["v4"] for V4 pools
}

// ---------- Discovery ----------

async function fetchDexScreener(tokenAddress: Address): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/tokens/v1/base/${tokenAddress.toLowerCase()}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ! Dexscreener ${res.status} for ${tokenAddress}`);
    return [];
  }
  const data = (await res.json()) as DexScreenerPair[] | { pairs: DexScreenerPair[] };
  // The /tokens/v1 endpoint returns an array directly; older /tokens/{addr} returns { pairs }
  return Array.isArray(data) ? data : data.pairs ?? [];
}

function isUsdc(addr: string): boolean {
  return addr.toLowerCase() === USDC.toLowerCase();
}
function isWeth(addr: string): boolean {
  return addr.toLowerCase() === WETH.toLowerCase();
}

function classifyPair(p: DexScreenerPair): {
  quote: 'USDC' | 'WETH' | 'OTHER';
  version: 'v2' | 'v3' | 'v4' | 'unknown';
} {
  const quoteAddr = p.quoteToken.address;
  const quote = isUsdc(quoteAddr) ? 'USDC' : isWeth(quoteAddr) ? 'WETH' : 'OTHER';
  const labels = (p.labels ?? []).map((l) => l.toLowerCase());
  const dex = p.dexId.toLowerCase();
  let version: 'v2' | 'v3' | 'v4' | 'unknown' = 'unknown';
  if (labels.includes('v4') || dex.includes('v4')) version = 'v4';
  else if (labels.includes('v3') || dex.includes('v3') || dex === 'uniswap') version = 'v3';
  else if (labels.includes('v2') || dex.includes('v2')) version = 'v2';
  return { quote, version };
}

async function fetchV4PoolKey(
  client: ReturnType<typeof createPublicClient>,
  poolId: Hex,
): Promise<{
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
} | null> {
  // V4 PoolManager was deployed Jan 2025 on Base (block ~25M+). Search from
  // genesis is OK for an indexed RPC; if that fails, narrow the range.
  try {
    const logs = await client.getLogs({
      address: V4_POOL_MANAGER,
      event: INITIALIZE_EVENT,
      args: { id: poolId },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    if (logs.length === 0) return null;
    const a = logs[0]!.args;
    if (!a.currency0 || !a.currency1 || a.fee === undefined || a.tickSpacing === undefined || !a.hooks) {
      return null;
    }
    return {
      currency0: a.currency0 as Address,
      currency1: a.currency1 as Address,
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
      hooks: a.hooks as Address,
    };
  } catch (err) {
    console.error(`    ! getLogs failed for ${poolId}: ${(err as Error).message}`);
    return null;
  }
}

async function findV3PoolForPair(
  client: ReturnType<typeof createPublicClient>,
  tokenA: Address,
  tokenB: Address,
): Promise<{ pool: Address; fee: number; liquidity: bigint } | null> {
  let best: { pool: Address; fee: number; liquidity: bigint } | null = null;
  for (const fee of V3_FEE_TIERS) {
    const pool = (await client.readContract({
      address: V3_FACTORY,
      abi: V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA, tokenB, fee],
    })) as Address;
    if (pool === zeroAddress) continue;
    const liquidity = (await client.readContract({
      address: pool,
      abi: V3_POOL_ABI,
      functionName: 'liquidity',
    })) as bigint;
    if (liquidity === 0n) continue;
    if (!best || liquidity > best.liquidity) best = { pool, fee, liquidity };
  }
  return best;
}

// ---------- Main ----------

async function main() {
  const client = createPublicClient({
    chain: base,
    transport: fallback([
      http('https://base.drpc.org', { timeout: 15_000 }),
      http('https://base-rpc.publicnode.com', { timeout: 15_000 }),
      http('https://base.llamarpc.com', { timeout: 15_000 }),
    ]),
  });

  const recommendations: { symbol: string; snippet: string }[] = [];

  for (const token of BASKET) {
    const addr = getAddress(token.address);
    console.log(`\n=== ${token.symbol} ${addr} ===`);

    // --- Dexscreener pass ---
    const pairs = await fetchDexScreener(addr);
    if (pairs.length === 0) {
      console.log('  (Dexscreener returned no pairs)');
    } else {
      const ranked = pairs
        .map((p) => ({ ...p, classified: classifyPair(p) }))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      console.log(`  Dexscreener (${ranked.length} pairs, top 5 by liquidity):`);
      for (const p of ranked.slice(0, 5)) {
        const tvl = p.liquidity?.usd ? `$${Math.round(p.liquidity.usd).toLocaleString()}` : 'n/a';
        const vol = p.volume?.h24 ? `$${Math.round(p.volume.h24).toLocaleString()}/d` : 'n/a';
        console.log(
          `    [${p.classified.version}/${p.classified.quote}] ${p.dexId} ${p.pairAddress}  TVL=${tvl} vol24h=${vol}`,
        );
      }
    }

    // --- On-chain V3 pass ---
    console.log('  V3 USDC pools (factory.getPool across fee tiers):');
    const v3Usdc = await findV3PoolForPair(client, addr, USDC);
    if (v3Usdc) {
      console.log(
        `    BEST: ${v3Usdc.pool}  fee=${v3Usdc.fee}  liquidity=${v3Usdc.liquidity.toString()}`,
      );
    } else {
      console.log('    none');
    }

    console.log('  V3 WETH pools (factory.getPool across fee tiers):');
    const v3Weth = await findV3PoolForPair(client, addr, WETH);
    if (v3Weth) {
      console.log(
        `    BEST: ${v3Weth.pool}  fee=${v3Weth.fee}  liquidity=${v3Weth.liquidity.toString()}`,
      );
    } else {
      console.log('    none');
    }

    // --- V4 PoolKey extraction (for any V4 pools Dexscreener flagged) ---
    const v4Candidates = (pairs ?? [])
      .map((p) => ({ ...p, classified: classifyPair(p) }))
      .filter((p) => p.classified.version === 'v4');

    const v4Resolved: {
      quote: 'USDC' | 'WETH' | 'OTHER';
      poolId: Hex;
      key: Awaited<ReturnType<typeof fetchV4PoolKey>>;
      tvlUsd: number;
    }[] = [];
    if (v4Candidates.length > 0) {
      console.log('  V4 PoolKey lookup (Initialize event, fallback brute-force):');
      for (const c of v4Candidates) {
        const poolId = c.pairAddress as Hex;
        let key = await fetchV4PoolKey(client, poolId);
        let source = 'event';
        if (!key) {
          // RPC rejected the broad eth_getLogs — try brute-forcing against known hooks.
          const otherToken = c.classified.quote === 'USDC' ? USDC : WETH;
          const bf = bruteForcePoolKey(poolId, addr, otherToken);
          if (bf) {
            key = { currency0: '0x' as Address, currency1: '0x' as Address, ...bf };
            source = `brute-force (${bf.hookLabel})`;
          }
        }
        v4Resolved.push({
          quote: c.classified.quote,
          poolId,
          key,
          tvlUsd: c.liquidity?.usd ?? 0,
        });
        if (key) {
          console.log(
            `    [${c.classified.quote}] ${poolId.slice(0, 10)}... [${source}] fee=${key.fee} tickSpacing=${key.tickSpacing} hooks=${key.hooks}`,
          );
        } else {
          console.log(`    [${c.classified.quote}] ${poolId.slice(0, 10)}... — UNRESOLVED`);
        }
      }
    }

    // --- V3 quote validation: $5 USDC through each candidate path ---
    const FIVE_USDC = 5_000_000n;
    console.log('  V3 quote check (5 USDC -> token):');
    if (v3Usdc) {
      const out = await quoteV3(client, [USDC, addr], [v3Usdc.fee], FIVE_USDC);
      console.log(
        `    direct USDC fee=${v3Usdc.fee}: ${out === null ? 'REVERT' : out.toString() + ' raw out'}`,
      );
    }
    if (v3Weth) {
      const out = await quoteV3(client, [USDC, WETH, addr], [500, v3Weth.fee], FIVE_USDC);
      console.log(
        `    multi-hop via WETH fee=500/${v3Weth.fee}: ${out === null ? 'REVERT' : out.toString() + ' raw out'}`,
      );
    }

    // --- Recommendation ---
    // Priority order: direct V3/USDC > V3 multi-hop USDC->WETH > V4 direct/USDC > V4 multi-hop USDC->WETH
    const v4Usdc = v4Resolved.find((p) => p.quote === 'USDC' && p.key);
    const v4Weth = v4Resolved.find((p) => p.quote === 'WETH' && p.key);

    let snippet: string;
    if (v3Usdc && v3Usdc.liquidity > 1_000_000_000_000n /* skip dust pools */) {
      snippet = `// ${token.symbol}: V3 direct USDC, fee=${v3Usdc.fee}
{ symbol: '${token.symbol}', address: '${addr}', decimals: ${token.decimals},
  pathTokens: [USDC, '${addr}'],
  hops: [{ version: 'v3', fee: ${v3Usdc.fee} }] },`;
    } else if (v4Usdc && v4Usdc.key) {
      const k = v4Usdc.key;
      snippet = `// ${token.symbol}: V4 direct USDC pool ${v4Usdc.poolId.slice(0, 10)}...
{ symbol: '${token.symbol}', address: '${addr}', decimals: ${token.decimals},
  pathTokens: [USDC, '${addr}'],
  hops: [{ version: 'v4', fee: ${k.fee}, tickSpacing: ${k.tickSpacing}, hooks: '${k.hooks}' }] },`;
    } else if (v3Weth && v3Weth.liquidity > 1_000_000_000_000n) {
      snippet = `// ${token.symbol}: V3 multi-hop USDC -> WETH (V3 fee=500) -> ${token.symbol} (V3 fee=${v3Weth.fee})
{ symbol: '${token.symbol}', address: '${addr}', decimals: ${token.decimals},
  pathTokens: [USDC, WETH, '${addr}'],
  hops: [{ version: 'v3', fee: 500 }, { version: 'v3', fee: ${v3Weth.fee} }] },`;
    } else if (v4Weth && v4Weth.key) {
      const k = v4Weth.key;
      snippet = `// ${token.symbol}: multi-hop USDC -> WETH (V3 fee=500) -> ${token.symbol} (V4 hook ${k.hooks})
{ symbol: '${token.symbol}', address: '${addr}', decimals: ${token.decimals},
  pathTokens: [USDC, WETH, '${addr}'],
  hops: [{ version: 'v3', fee: 500 }, { version: 'v4', fee: ${k.fee}, tickSpacing: ${k.tickSpacing}, hooks: '${k.hooks}' }] },`;
    } else {
      snippet = `// ${token.symbol}: NO USABLE POOL FOUND — manual inspection required.`;
    }
    recommendations.push({ symbol: token.symbol, snippet });
  }

  // ---------- Summary ----------
  console.log('\n\n========== RECOMMENDATIONS ==========\n');
  for (const r of recommendations) {
    console.log(r.snippet);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
