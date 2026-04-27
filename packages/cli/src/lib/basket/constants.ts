import type { Address } from 'viem';

// Uniswap deployments on Base mainnet (chain id 8453).
// Source: https://developers.uniswap.org/contracts/v4/deployments
//         https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments
export const UNIVERSAL_ROUTER: Address = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
export const V4_POOL_MANAGER: Address = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
export const V4_QUOTER: Address = '0x0d5e0F971ED27FBfF6c2837bf31316121532048D';
export const V3_FACTORY: Address = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
export const V3_QUOTER_V2: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WETH: Address = '0x4200000000000000000000000000000000000006';

// Clanker V4 hooks set fee = 0x800000 to flag the dynamic-fee hook.
export const DYNAMIC_FEE_FLAG = 0x800000;

export type SingleHopPool =
  | { version: 'v3'; fee: number }
  | { version: 'v4'; fee: number; tickSpacing: number; hooks: Address };

export interface BasketTokenConfig {
  symbol: string;
  address: Address;
  decimals: number;
  // Filled in by scripts/find-pools.ts. pathTokens[0] is always USDC; the last
  // entry is the basket token. For single-hop USDC<->TOKEN, pathTokens has length 2.
  // For USDC->WETH->TOKEN, length 3.
  pathTokens?: Address[];
  hops?: SingleHopPool[];
}

// Pool routing discovered via scripts/find-pools.ts and scripts/find-v4-key.ts.
// Inline comments record each path's executable-liquidity check ($5 USDC quote).
export const BASKET: BasketTokenConfig[] = [
  {
    // 7.24 VIRTUAL ≈ $5.00 — near-zero slippage at $5.
    symbol: 'VIRTUAL',
    address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
    decimals: 18,
    pathTokens: [USDC, '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'],
    hops: [{ version: 'v3', fee: 3000 }],
  },
  {
    // V4-only token (Doppler/Bankr launch). Hook deterministically mined per
    // token; not one of Clanker's shared hooks. Verify with find-v4-key.ts if
    // republished. Initialize tx 0xf7d15701...d2d7a377f at block 43275355.
    symbol: 'ROBOT',
    address: '0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3',
    decimals: 18,
    pathTokens: [USDC, WETH, '0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3'],
    hops: [
      { version: 'v3', fee: 500 },
      {
        version: 'v4',
        fee: DYNAMIC_FEE_FLAG,
        tickSpacing: 200,
        hooks: '0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0',
      },
    ],
  },
  {
    // 15,934 BNKR ≈ $4.78 via WETH leg (~4% slippage at $5). Direct USDC/fee=100
    // pool is dust — only $0.65 out for $5 in. Multi-hop is the right call.
    symbol: 'BNKR',
    address: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b',
    decimals: 18,
    pathTokens: [USDC, WETH, '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b'],
    hops: [
      { version: 'v3', fee: 500 },
      { version: 'v3', fee: 10000 },
    ],
  },
  {
    // 1,102,773 JUNO ≈ $4.97 — <1% slippage on V3.
    // Note: Clanker V4 pool also exists (hook 0xb429d62f...28CC, fee=0x800000,
    // tickSpacing=200) but V3 fills better.
    symbol: 'JUNO',
    address: '0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07',
    decimals: 18,
    pathTokens: [USDC, '0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07'],
    hops: [{ version: 'v3', fee: 10000 }],
  },
  {
    // 518 ZFI for $5 — executable via WETH multi-hop.
    symbol: 'ZFI',
    address: '0xD080eD3c74a20250a2c9821885203034ACD2D5ae',
    decimals: 18,
    pathTokens: [USDC, WETH, '0xD080eD3c74a20250a2c9821885203034ACD2D5ae'],
    hops: [
      { version: 'v3', fee: 500 },
      { version: 'v3', fee: 10000 },
    ],
  },
  {
    // 485 GIZA for $5 — executable via Uniswap V3/WETH. Aerodrome surface
    // looked dead but Uniswap fills cleanly.
    symbol: 'GIZA',
    address: '0x590830dFDf9A3F68aFCDdE2694773dEBDF267774',
    decimals: 18,
    pathTokens: [USDC, WETH, '0x590830dFDf9A3F68aFCDdE2694773dEBDF267774'],
    hops: [
      { version: 'v3', fee: 500 },
      { version: 'v3', fee: 10000 },
    ],
  },
];

// 95/5 split between vault leg and basket leg of a deposit.
export const VAULT_SPLIT_BPS = 9500;
export const BASKET_SPLIT_BPS = 500;
export const BPS_DENOMINATOR = 10000;

// Single slippage default of 3% — safe across both V3 and Clanker V4 dynamic-fee
// pools, which can spike fees up to 80% during volatility. Split into per-engine
// flags later if telemetry shows V3 legs leaving money on the table.
export const DEFAULT_SLIPPAGE_BPS = 300;

// Minutes of validity for a quote. Re-quote in execute-* before broadcast.
export const QUOTE_VALIDITY_MINUTES = 5;
