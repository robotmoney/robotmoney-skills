# Write command response schemas

Two families of write commands:

- **`prepare-*`** returns unsigned calldata. The caller signs and broadcasts externally.
- **`execute-*`** signs and broadcasts end-to-end via OWS. Returns confirmed transaction hashes.

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
  --user-address 0xYou --amount 100 --receiver 0xYou
```

Automatically includes a USDC approval tx if the current allowance is less than
`amount`. Pass `--skip-approve` to omit it.

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
(`TVLCapExceeded` or `PerDepositCapExceeded`).

---

## `prepare-redeem`

```bash
npx @robotmoney/cli prepare-redeem --chain base \
  --user-address 0xYou --shares max --receiver 0xYou
```

`--shares` accepts a decimal number or the literal string `max` (reads
`balanceOf(user)`).

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
  --user-address 0xYou --amount 50 --receiver 0xYou
```

`--amount` is the **net** USDC the caller wants to receive. The CLI computes
the shares required to produce that net amount after the exit fee.

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
