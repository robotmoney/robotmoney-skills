# Write command response schemas

Two families of write commands:

- **`prepare-*`** returns unsigned calldata. The caller signs and broadcasts externally.
- **`execute-*`** signs and broadcasts end-to-end via OWS. Returns confirmed transaction hashes.

> **Heads up: basket leg.** Since v0.2.0, every `prepare-deposit` / `execute-deposit` also buys a 6-token basket (5% of the deposit by default), and `prepare-redeem` / `prepare-withdraw` (and their execute siblings) accept basket-sell flags. Responses include an extra `basket` object with per-leg quotes. New flags below — full spec in [`references/basket.md`](basket.md).

Every `prepare-*` command returns the same top-level shape:

```json
{
  "operation": {
    "type": "deposit" | "redeem" | "withdraw",
    "summary": "...",
    "transactions": [
      { "to": "0x...", "data": "0x...", "value": "0", "description": "..." }
    ],
    "warnings": []
  },
  "simulation": {
    "allSucceeded": true,
    "gasEstimate": "480000",
    "failures": [],
    "preview": { /* command-specific */ }
  }
}
```

- `operation.transactions` — array of unsigned transactions to be signed and broadcast **in order** by the caller's wallet.
- `operation.warnings` — human-readable strings flagging risks or probable reverts (TVL cap exceeded, paused vault, etc.).
- `simulation.allSucceeded` — `true` if every tx simulated cleanly. Note: in the two-tx approve+deposit sequence, the second tx will typically fail simulation because the approval has not been mined yet. That is **expected** and not a real error — broadcast sequentially.
- `simulation.failures` — for each failing tx: `{index, description, revert, message}`.
- `simulation.preview` — command-specific preview of expected shares or assets.

---

## `prepare-deposit`

```bash
npx @robotmoney/cli prepare-deposit --chain base \
  --user-address 0xYou --amount 100 --receiver 0xYou \
  [--no-basket | --basket-only] \
  [--slippage-bps 300]
```

Default behavior splits 95% to the vault + 5% across the 6-token basket. Pass
`--no-basket` for the legacy vault-only flow, `--basket-only` to skip the vault
leg, or `--slippage-bps N` (default 300 = 3%) to tighten/loosen basket slippage.

Automatically includes USDC approval txs if the current allowances are less
than what the legs need (vault leg uses direct USDC.approve(vault); basket leg
uses USDC.approve(Permit2) + Permit2.approve(USDC→UniversalRouter), both with
1-year expiration). Skipped when allowances already cover the amounts.

```json
{
  "operation": {
    "type": "deposit",
    "summary": "Deposit 100 USDC → mint ~100 rmUSDC to 0xYou",
    "transactions": [
      { "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "data": "0x095ea7b3...", "value": "0", "description": "USDC.approve(vault, 100000000)" },
      { "to": "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd", "data": "0x6e553f65...", "value": "0", "description": "vault.deposit(100000000, 0xYou)" }
    ],
    "warnings": []
  },
  "simulation": {
    "allSucceeded": false,
    "gasEstimate": "56240",
    "failures": [
      {
        "index": 1,
        "description": "vault.deposit(100000000, 0xYou)",
        "revert": null,
        "message": "Execution reverted with reason: ERC20: transfer amount exceeds allowance."
      }
    ],
    "preview": {
      "sharesToMint": "100",
      "sharesRaw": "100000000"
    }
  }
}
```

If the deposit would exceed `tvlCap` or `perDepositCap`, a warning is added to
`operation.warnings` and the simulation will also show the corresponding revert
(`TVLCapExceeded` or `PerDepositCapExceeded`). The cap checks apply to the
**vault leg only** (95% of `--amount` by default), not the basket portion.

When the basket leg is included, the response also has a `basket` field:

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
      { "symbol": "VIRTUAL", "address": "0x0b3e...", "amountOut": "1206466336985350458", "minAmountOut": "1170272346875789944", "decimals": 18 },
      /* ... 5 more quotes ... */
    ]
  }
}
```

The transactions array contains, in order: USDC→vault approval (if needed),
`vault.deposit`, USDC→Permit2 approval (if needed), Permit2→UR approval (if
needed), and the single `UR.execute()` for the atomic 6-leg basket buy.

---

## `prepare-redeem`

```bash
npx @robotmoney/cli prepare-redeem --chain base \
  --user-address 0xYou --shares max --receiver 0xYou \
  [--sell-all | --sell-percent N | --sell-tokens VIRTUAL,JUNO [--sell-amounts 1.5,200]] \
  [--slippage-bps 300]
```

`--shares` accepts a decimal number, the literal string `max` (reads
`balanceOf(user)`), or `0` to **skip the vault leg** entirely (basket-sell only).

The basket-sell flags are documented in full in [`basket.md`](basket.md).
TL;DR:
- `--sell-all` sells 100% of every basket-token holding
- `--sell-percent N` sells N% of every holding (1-100)
- `--sell-tokens X,Y` scopes to specific symbols (defaults to selling full balance of each)
- `--sell-amounts A,B` pairs 1:1 with `--sell-tokens` for explicit decimals
- Tokens with zero balance are silently skipped

When sell flags are passed, the response gains a `basket` field with per-leg
USDC quotes and `minUsdcOut`. The transactions array adds per-token Permit2
approvals (skipped if already valid) and a final `UR.execute()` containing all
the basket-sell legs in one atomic call.

```json
{
  "operation": {
    "type": "redeem",
    "summary": "Redeem 100 rmUSDC → 99.75 USDC to 0xYou (after 0.25 USDC exit fee)",
    "transactions": [
      { "to": "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd", "data": "0xba087652...", "value": "0", "description": "vault.redeem(100000000, 0xYou, 0xYou)" }
    ],
    "warnings": []
  },
  "simulation": {
    "allSucceeded": true,
    "gasEstimate": "350000",
    "failures": [],
    "preview": {
      "sharesRaw": "100000000",
      "grossUsdc": "100",
      "feeUsdc": "0.25",
      "netUsdc": "99.75",
      "netUsdcRaw": "99750000"
    }
  }
}
```

---

## `prepare-withdraw`

```bash
npx @robotmoney/cli prepare-withdraw --chain base \
  --user-address 0xYou --amount 50 --receiver 0xYou \
  [...same basket-sell flags as prepare-redeem...]
```

`--amount` is the **net** USDC the caller wants to receive. The CLI computes
the shares required to produce that net amount after the exit fee. Pass
`--amount 0` to skip the vault leg (basket-sell only). The basket-sell flags
behave identically to `prepare-redeem` — see [`basket.md`](basket.md).

```json
{
  "operation": {
    "type": "withdraw",
    "summary": "Withdraw 50 USDC net (burn ~50.125 rmUSDC, 0.125 USDC exit fee) → 0xYou",
    "transactions": [
      { "to": "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd", "data": "0xb460af94...", "value": "0", "description": "vault.withdraw(50000000, 0xYou, 0xYou)" }
    ],
    "warnings": []
  },
  "simulation": {
    "allSucceeded": true,
    "gasEstimate": "350000",
    "failures": [],
    "preview": {
      "sharesRequired": "50.125",
      "sharesRequiredRaw": "50125312",
      "grossUsdc": "50.125",
      "feeUsdc": "0.125",
      "netUsdc": "50"
    }
  }
}
```

---

## `execute-*` shape

Every `execute-*` command returns:

```json
{
  "operation": {
    "type": "deposit" | "redeem" | "withdraw",
    "summary": "...",
    "wallet": { "name": "my-agent", "address": "0x..." },
    "receiver": "0x..."
  },
  "transactions": [
    {
      "hash": "0xabc...",
      "description": "USDC.approve(vault, 100000000)",
      "status": "confirmed",
      "blockNumber": "44700123",
      "gasUsed": "56240"
    },
    {
      "hash": "0xdef...",
      "description": "vault.deposit(100000000, 0x...)",
      "status": "confirmed",
      "blockNumber": "44700124",
      "gasUsed": "1804352"
    }
  ],
  "preview": { /* command-specific — e.g. receiverShareBalance, netUsdc, feeUsdc */ },
  "warnings": []
}
```

- `transactions[*].status` is `"confirmed"`, `"reverted"`, or `"pending"` (the latter when the 120s wait timed out).
- On failure (pre-broadcast gas estimate revert, insufficient ETH, wallet not found, etc.) the command exits non-zero with a JSON error on stderr.

### `execute-deposit`

```bash
npx @robotmoney/cli execute-deposit --chain base --wallet my-agent --amount 100
```

Optional flags: `--receiver <address>` (defaults to the wallet address), `--passphrase <string>`, `--storage-path <dir>`.

### `execute-redeem`

```bash
npx @robotmoney/cli execute-redeem --chain base --wallet my-agent --shares max
```

`--shares` accepts a decimal or the literal string `max`.

### `execute-withdraw`

```bash
npx @robotmoney/cli execute-withdraw --chain base --wallet my-agent --amount 50
```

`--amount` is the **net** USDC the caller wants to receive after the exit fee.

---

## `create-wallet`

Creates a new [Open Wallet Standard](https://openwallet.sh/) (OWS) wallet for
an agent or machine without one. Keystore is encrypted and stored locally.
The CLI itself never holds keys — OWS manages them via its native library.

```bash
npx @robotmoney/cli create-wallet [--label my-agent] [--storage-path ./ows] [--passphrase ***]
```

```json
{
  "provider": "ows",
  "providerVersion": "1.2.4",
  "address": "0xAgentAddressHere",
  "chain": "base",
  "name": "my-agent",
  "storagePath": "~/.ows/wallets/",
  "instructions": [
    "1. Your wallet has been created and encrypted at the storage path above.",
    "2. Fund it with USDC on Base. Options:",
    "   - Coinbase: withdraw USDC to your address, select Base network",
    "   - Bridge: https://bridge.base.org",
    "   - Any CEX/DEX that supports Base withdrawals",
    "3. Prepare a deposit with: robotmoney prepare-deposit --chain base --user-address 0xAgentAddressHere --amount 100 --receiver 0xAgentAddressHere",
    "4. Sign the returned transactions via your OWS policy flow and broadcast them to Base."
  ],
  "fundingOptions": [
    { "method": "coinbase-direct", "description": "Withdraw USDC from Coinbase to this address on Base" },
    { "method": "base-bridge", "url": "https://bridge.base.org" },
    { "method": "dex-swap", "description": "Swap any Base token for USDC via Uniswap or Aerodrome" }
  ]
}
```

OWS ships native bindings only for darwin/linux x64/arm64 — Windows and
linux-musl are not supported as of OWS `1.2.4`. The OWS dependency is
imported lazily, so users who never run `create-wallet` never pay the
install cost.
