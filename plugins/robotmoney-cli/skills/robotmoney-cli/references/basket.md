# Basket leg

Every `prepare-deposit` and `execute-deposit` now mints rmUSDC **and** atomically buys a fixed 6-token "agent token" basket via Uniswap UniversalRouter on Base. Every `prepare-redeem`, `execute-redeem`, `prepare-withdraw`, and `execute-withdraw` can sell user-specified portions of those holdings back to USDC in the same call as the vault leg.

This document explains the basket: which tokens are in it, how the splits work, the new flags, and the response shape.

## Composition

The basket is hardcoded — 6 agent tokens on Base. Composition changes only via a new release.

| Symbol | Address | Path to USDC | Notes |
|---|---|---|---|
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | V3 direct USDC, fee=3000 | Virtuals Protocol; deepest book |
| ROBOT | `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` | USDC → WETH (V3 fee=500) → ROBOT (V4 dynamic-fee hook) | Bankr/Doppler launch; only V4 leg in the basket |
| BNKR | `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b` | USDC → WETH (V3 fee=500) → BNKR (V3 fee=10000) | BankrCoin |
| JUNO | `0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07` | V3 direct USDC, fee=10000 | Juno Agent |
| ZFI | `0xD080eD3c74a20250a2c9821885203034ACD2D5ae` | USDC → WETH (V3 fee=500) → ZFI (V3 fee=10000) | ZyFAI |
| GIZA | `0x590830dFDf9A3F68aFCDdE2694773dEBDF267774` | USDC → WETH (V3 fee=500) → GIZA (V3 fee=10000) | Giza |

Routing was discovered by `scripts/find-pools.ts` and `scripts/find-v4-key.ts`. ROBOT's V4 PoolKey was extracted from the on-chain `Initialize` event: `fee=0x800000, tickSpacing=200, hooks=0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0`.

## Defaults

- **Split**: 95% to vault, 5% to basket. Basket is divided **equally** across the 6 tokens (~83 bps each). Dust from integer division goes to the first leg.
- **Slippage**: `--slippage-bps 300` (3%) on every basket swap. Conservative default that survives Clanker dynamic-fee spikes (fees can hit 80% during volatility) without rekting V3 legs.
- **Quote validity**: 5 minutes. The UR `execute()` deadline embedded in the calldata is `now + 5min` at prepare time. The response includes a `validUntil` (unix seconds) — re-quote if the user takes longer than that to sign.
- **Approvals**: USDC and each basket token are approved to **Permit2** (max), then **Permit2 approves UniversalRouter** for that token (max uint160, expiration = now + 1 year). The CLI only emits approval txs that are missing or expired.

## Tokens land directly in the user wallet

Basket tokens are **not** wrapped — UniversalRouter delivers each ERC-20 directly to `--receiver` in the same transaction. There is no share token, no claim, no subsequent step.

## Deposit flags

```bash
robotmoney prepare-deposit --chain base \
  --user-address 0xYou --amount 100 --receiver 0xYou \
  [--no-basket | --basket-only] \
  [--slippage-bps 300]

robotmoney execute-deposit --chain base --wallet my-agent --amount 100 \
  [--no-basket | --basket-only] \
  [--slippage-bps 300]
```

| Flag | Effect |
|---|---|
| (none) | 95/5 split — default behavior |
| `--no-basket` | vault-only mode — skips the basket entirely |
| `--basket-only` | basket-only mode — full `--amount` goes to swaps; no vault deposit |
| `--slippage-bps N` | slippage tolerance for basket swaps; 300 = 3%, default |

`--no-basket` and `--basket-only` are mutually exclusive.

## Redeem & withdraw flags

```bash
robotmoney prepare-redeem --chain base \
  --user-address 0xYou --shares max --receiver 0xYou \
  [--sell-all | --sell-percent N | --sell-tokens SYMS [--sell-amounts DECS]] \
  [--slippage-bps 300]

robotmoney prepare-withdraw --chain base \
  --user-address 0xYou --amount 50 --receiver 0xYou \
  [...same basket-sell flags...]
```

`--shares` and `--amount` accept `0` to mean "skip the vault leg". A redeem call with `--shares 0 --sell-all` will only sell basket tokens, not touch the vault.

| Flag | Effect |
|---|---|
| `--sell-all` | sell 100% of every basket token the wallet holds |
| `--sell-percent N` | sell N% of every basket token holding (1-100) |
| `--sell-tokens VIRTUAL,JUNO` | only these symbols (case-insensitive) |
| `--sell-amounts 1.5,200` | decimal amounts paired 1:1 with `--sell-tokens` |
| `--slippage-bps N` | slippage tolerance for the sells |

Composition rules:
- `--sell-all` and `--sell-percent` are mutually exclusive
- `--sell-tokens` alone sells the full balance of those tokens
- `--sell-tokens` + `--sell-percent N` sells N% of those specific tokens
- `--sell-tokens` + `--sell-amounts` requires both lists to be the same length; each amount is parsed using its token's decimals
- Tokens with zero balance are silently skipped — no error, no reverting tx

## Response shape

Both `prepare-*` and `execute-*` return the existing top-level keys plus a `basket` object. For deposits:

```json
{
  "operation": { /* ... */ },
  "simulation": { /* ... */ },
  "basket": {
    "totalUsdc": "5",
    "perLegUsdc": "0.833333",
    "slippageBps": 300,
    "validUntil": 1777323066,
    "quotes": [
      {
        "symbol": "VIRTUAL",
        "address": "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
        "amountOut": "1206466336985350458",
        "minAmountOut": "1170272346875789944",
        "decimals": 18
      },
      /* ... 5 more quotes ... */
    ]
  }
}
```

For redeems & withdraws with sells:

```json
{
  "operation": { /* ... */ },
  "simulation": { /* ... */ },
  "basket": {
    "slippageBps": 300,
    "validUntil": 1777323066,
    "sells": [
      {
        "symbol": "VIRTUAL",
        "address": "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
        "amountIn": "1000000000000000000",
        "usdcOut": "693254",
        "minUsdcOut": "672456"
      },
      /* ... per-leg ... */
    ]
  }
}
```

## `get-basket-holdings`

```bash
robotmoney get-basket-holdings --chain base --user-address 0xYou
```

Returns each basket token's balance for the user, plus the USDC equivalent value (computed by quoting the full balance back to USDC at current pool prices).

```json
{
  "user": "0xYou",
  "holdings": [
    {
      "symbol": "VIRTUAL",
      "address": "0x...",
      "decimals": 18,
      "balance": "2.81437",
      "balanceRaw": "2814371232330785239",
      "usdValue": "1.932301",
      "usdValueRaw": "1932301"
    },
    /* ... */
  ],
  "totalUsdValue": "499961.886923",
  "totalUsdValueRaw": "499961886923"
}
```

Pass `--no-pricing` to skip the quoter calls (faster, no USD valuation in the response).

## Transaction count

Worst case (all approvals fresh) for a 95/5 deposit:

1. `USDC.approve(VAULT, 95)` — vault leg approval
2. `vault.deposit(95, receiver)` — vault leg
3. `USDC.approve(Permit2, max)` — basket leg approval (one-time forever per wallet)
4. `Permit2.approve(USDC → UR, max, +1y)` — basket leg approval (one-time per wallet/year)
5. `UR.execute(...)` — atomic 6-leg basket buy

Steps 3–4 are skipped on subsequent deposits. Steady-state cost: 3 txs per deposit (or 1 tx if Permit2 approvals are fresh from a prior deposit).

A full sell of all 6 basket tokens (`--sell-all`) emits up to **2 approvals × 6 tokens + 1 UR.execute = 13 txs** the first time. Subsequent sells reuse the approvals.

## Universal Router calldata structure

For the curious, the `UR.execute()` calldata uses these commands:

- `0x00 V3_SWAP_EXACT_IN` — single-hop or packed multi-hop V3 swap; one per V3-routable token
- `0x10 V4_SWAP` — used only for ROBOT's V4 leg, wrapping `SWAP_EXACT_IN_SINGLE` + `SETTLE_ALL` + `TAKE_ALL` actions
- `0x04 SWEEP` — refunds any leftover USDC (or token, on sells) to the recipient

The full UR command for a deposit is: `[V3, V3, V4, V3, V3, V3, V3, SWEEP]` — VIRTUAL (V3), ROBOT V3 leg + V4 leg, then BNKR/JUNO/ZFI/GIZA (each V3), then SWEEP.

## Open items / known limits

- Composition is hardcoded; updating tokens requires a new CLI release.
- The 95/5 split is fixed; no way to override at call time.
- Basket buys are atomic in one UR.execute — if any leg's slippage exceeds tolerance, the whole basket reverts. The vault leg is a separate tx and stays committed.
- Re-quoting drift: the response embeds `validUntil` and the `execute-*` commands re-quote internally before broadcast.
- ROBOT's V4 hook is mined per-token via Doppler; if Doppler ever migrates the pool to a new hook, `find-v4-key.ts` re-runs and the constants need updating.
