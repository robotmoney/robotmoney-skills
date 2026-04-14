# Read command response schemas

All read commands output JSON to stdout. Every numeric value sent on-chain is
returned twice: once as a human-readable decimal string (e.g. `"100.00"`) and
once as a raw wei/smallest-unit string (e.g. `"100000000"` for 100 USDC).

Every command accepts:

- `--chain base` (required)
- `--rpc-url <url>` (optional, falls back to `RPC_URL` env, then `https://base.llamarpc.com`)
- `--pretty` (optional, pretty-print JSON)

---

## `health-check`

```bash
npx @robotmoney/cli health-check --chain base
```

```json
{
  "ok": true,
  "chain": "base",
  "chainId": 8453,
  "blockNumber": "44672337",
  "rpcLatencyMs": 336,
  "vault": "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
  "paused": false,
  "shutdown": false
}
```

Non-zero exit code if the RPC or vault read fails. On failure, stderr contains
a JSON object with `{ code, error }`.

---

## `get-vault`

```bash
npx @robotmoney/cli get-vault --chain base
```

```json
{
  "address": "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
  "asset": { "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "symbol": "USDC", "decimals": 6 },
  "shareToken": { "symbol": "rmUSDC", "decimals": 6 },
  "totalAssets": "0",
  "totalAssetsRaw": "0",
  "totalShares": "0",
  "totalSharesRaw": "0",
  "sharePrice": "1.0",
  "paused": false,
  "shutdown": false,
  "tvlCap": "500",
  "tvlCapRaw": "500000000",
  "tvlCapReached": false,
  "perDepositCap": "100",
  "perDepositCapRaw": "100000000",
  "exitFeeBps": 25,
  "feeRecipient": "0xf9572bDF7dA594a8A92CC33142f0F053eB6ff03F",
  "activeAdapterCount": 3,
  "currentTargetBps": 3333
}
```

With `--verbose`, an additional `adapters` array is included:

```json
{
  "adapters": [
    {
      "index": 0,
      "address": "0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9",
      "active": true,
      "capBps": 5000,
      "currentBalance": "0",
      "currentBalanceRaw": "0",
      "targetBps": 3333
    }
  ]
}
```

---

## `get-balance`

```bash
npx @robotmoney/cli get-balance --chain base --user-address 0xYourAddress
```

```json
{
  "user": "0xYourAddress",
  "shares": "100",
  "sharesRaw": "100000000",
  "grossValueUsdc": "102.34",
  "grossValueUsdcRaw": "102340000",
  "netValueUsdc": "102.08",
  "netValueUsdcRaw": "102080000",
  "exitFeeUsdc": "0.256",
  "exitFeeUsdcRaw": "256000"
}
```

`netValueUsdc` is the amount the user would actually receive if they redeemed
all shares right now, after the 0.25% exit fee.

---

## `get-apy`

```bash
npx @robotmoney/cli get-apy --chain base
```

```json
{
  "blendedApy": "0.0361",
  "blendedApyPct": "3.61%",
  "adapters": [
    {
      "index": 0,
      "protocol": "Morpho Gauntlet USDC Prime",
      "address": "0xa6Ed7B03BC82d7C6d4AC4fEb971A06550a7817e9",
      "apy": "0.0505",
      "apyPct": "5.05%",
      "weight": 0.3333333333333333
    },
    {
      "index": 1,
      "protocol": "Aave V3 USDC",
      "address": "0x218695BdAB0fe4F8d0a8eE590bc6F35820FC0beA",
      "apy": "0.0264",
      "apyPct": "2.64%",
      "weight": 0.3333333333333333
    },
    {
      "index": 2,
      "protocol": "Compound V3 cUSDCv3",
      "address": "0x8247DA22A59FcE074c102431048D0CE7294C2652",
      "apy": "0.0313",
      "apyPct": "3.13%",
      "weight": 0.3333333333333333
    }
  ]
}
```

### Notes on APY sources

- **Morpho** APY is the vault's `state.netApy` (already net of performance fees) from `https://api.morpho.org/graphql`, with `https://blue.morpho.org/graphql` as a fallback. If both are unreachable, the adapter APY is `null` and a `warnings` array is added to the response.
- **Aave V3** APY is `pool.getReserveData(USDC).currentLiquidityRate / 1e27` — already annualized.
- **Compound V3** APY is `comet.getSupplyRate(getUtilization()) × secondsPerYear / 1e18`.

Adapters with a `null` APY are excluded from the `blendedApy` calculation.
