---
name: robotmoney-cli
description: >
  Interact with the Robot Money stablecoin yield vault on Base. Use this skill when the user asks to:
  check the vault's current APY, TVL, caps, or adapter breakdown ("What's rmUSDC yielding right now?");
  check a user's rmUSDC balance or position value ("What's my balance?", "How much is my position worth?");
  deposit USDC into the vault ("Deposit 100 USDC into Robot Money", "Put some USDC into rmUSDC");
  withdraw from the vault ("Withdraw my USDC from rmUSDC", "Redeem all my rmUSDC");
  bootstrap a new wallet for an agent or machine that doesn't have one yet ("Create a wallet for this agent");
  prepare or simulate any Robot Money vault transaction.
---

# robotmoney-cli

> **Experimental (pre-v1.0)** — Command syntax, response schemas, and available operations may change. Always verify critical outputs independently.

Query the Robot Money stablecoin vault and build unsigned transactions. All commands output JSON to stdout. No private keys are ever held by the CLI — the CLI prepares transactions; the caller\u2019s wallet signs them externally. For agents without a wallet yet, `create-wallet` bootstraps one via Open Wallet Standard (OWS).

```bash
npx @robotmoney/cli <command> [options]
```

**Chain:** `base` only at launch. Every command requires `--chain base`.

**Vault:** `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` on Base — a multi-adapter ERC-4626 vault that splits USDC across Morpho Gauntlet USDC Prime, Aave V3, and Compound V3 by dynamic equal weight.

## Target users

This skill is for **AI agents and autonomous machines** — anything with a wallet that wants diversified USDC yield. Works the same whether you're a Claude Code session, a Cursor agent, an autonomous trading bot, an IoT device, or a peaq-network machine. Not a retail-wallet UX — all output is JSON and meant to be parsed, not read by humans.

## Response Schemas

- **[Read commands](references/read.md)** — exact JSON shapes for `health-check`, `get-vault`, `get-balance`, `get-apy`
- **[Write commands](references/write.md)** — exact JSON shapes for `prepare-deposit`, `prepare-redeem`, `prepare-withdraw`, `create-wallet`

## Quick Reference

```bash
# Wallet — bootstrap one if the agent/machine doesn't have one yet
npx @robotmoney/cli create-wallet [--label <string>] [--storage-path <dir>]

# Read — query protocol state (no wallet required)
npx @robotmoney/cli health-check --chain base
npx @robotmoney/cli get-vault    --chain base [--verbose]
npx @robotmoney/cli get-balance  --chain base --user-address 0x...
npx @robotmoney/cli get-apy      --chain base

# Write — prepare unsigned transactions (simulation runs automatically)
npx @robotmoney/cli prepare-deposit  --chain base --user-address 0x... --amount 100 --receiver 0x...
npx @robotmoney/cli prepare-redeem   --chain base --user-address 0x... --shares max --receiver 0x...
npx @robotmoney/cli prepare-withdraw --chain base --user-address 0x... --amount 50 --receiver 0x...
```

## Wallet Onboarding

If the caller (agent or machine) does **not** already have a wallet:

```bash
npx @robotmoney/cli create-wallet --label "my-agent"
```

This bootstraps a wallet via [Open Wallet Standard](https://openwallet.sh/) (OWS) — an open-source, cross-chain wallet standard designed for AI agents, with policy-gated signing. The keystore is encrypted locally in `~/.ows/wallets/` (or a custom path). The CLI itself never holds keys — OWS does.

If the caller **already has a wallet** (Coinbase Smart Wallet, Safe, Fireblocks, hardware wallet, Claude Code signer, etc.), skip `create-wallet`. Run `prepare-*` commands directly — the CLI returns unsigned calldata; sign and broadcast it with the caller\u2019s wallet.

## Write Workflow: Prepare → Present

Every write operation follows two steps. Simulation runs automatically inside `prepare-*`.

1. **Prepare** — run a `prepare-*` command. The CLI handles USDC decimals, allowances, approvals, and simulation automatically. Returns `{operation, simulation}` where `operation` has transactions/summary/warnings and `simulation` has execution results, gas, and a `preview` of expected shares/assets.
2. **Present** — show the summary, the list of unsigned transactions, simulation results, and any warnings to the user/caller. If `simulation.allSucceeded` is false, diagnose before presenting.

Then the caller\u2019s wallet signs and broadcasts (externally — the CLI itself does not sign).

## Simulation Failures

| Revert | Cause | What to do |
|--------|-------|------------|
| `ERC20InsufficientAllowance` | USDC allowance for the vault is below the deposit amount | Expected on the second tx of an approve+deposit pair (approval not mined yet). Broadcast approve first, then deposit. |
| `ERC20InsufficientBalance` | User lacks USDC | Fund the wallet first |
| `ERC4626ExceededMaxDeposit` | Deposit exceeds the vault's max for this receiver | Reduce amount; check TVL and per-deposit caps |
| `ERC4626ExceededMaxWithdraw` | Withdraw amount exceeds the owner's current balance | Use `prepare-redeem --shares max` to exit the full position |
| `ERC4626ExceededMaxRedeem` | Redeem shares exceed the owner's share balance | Use `--shares max`, which reads balanceOf automatically |
| `TVLCapExceeded` | Deposit would exceed vault TVL cap (500 USDC at soft launch) | Reduce amount or wait for cap raise |
| `PerDepositCapExceeded` | Single deposit exceeds per-deposit cap (100 USDC at soft launch) | Split into multiple deposits under the cap |
| `VaultShutdown` | Vault is permanently shut down — deposits disabled | Withdrawals still work; no new deposits accepted |
| `EnforcedPause` | Vault is paused (operational emergency) | Wait for unpause; withdrawals may still be available |
| `NoActiveAdapters` | No adapters are active | Operator attention required before any deposit |

**Why the approve+deposit simulation shows a failure on the second tx:** `eth_call` runs against the latest confirmed block, so the pending approval isn't applied when the vault.deposit call is simulated. This is expected. The transactions are correct — broadcast them sequentially and they will succeed.

## Vault mechanics

- **Deposit** mints rmUSDC shares and atomically routes USDC across active adapters by equal weight (3 adapters → 33.33% each)
- **Redeem** burns rmUSDC and returns USDC in one transaction, minus a 0.25% exit fee
- **Share price** grows over time as yield accrues in Morpho / Aave / Compound — no rebasing, no rebalancing delays
- **Preview functions** (`previewRedeem`, `previewWithdraw`) return NET USDC after fee — the caller-side exit amount
- **No cooldown, no lock** — deposit and withdraw are both synchronous, one transaction each

## Partial Withdrawal

If `prepare-withdraw --amount <large>` simulation fails due to insufficient adapter liquidity (rare — Aave/Morpho/Compound are deep), use `prepare-redeem --shares max` instead. It pulls proportionally from all adapters and caps at what's actually available.

## Contract addresses (Base)

| Contract | Address |
|---|---|
| Vault (RobotMoneyVault) | `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| MorphoAdapter | `0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9` |
| AaveV3Adapter | `0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea` |
| CompoundV3Adapter | `0x8247da22a59fce074c102431048d0ce7294c2652` |

Chain ID: 8453 (Base mainnet).
