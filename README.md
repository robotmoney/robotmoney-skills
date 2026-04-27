# Robot Money Skills

> **Experimental** — This project is pre-v1.0. Command syntax, response schemas, and behavior may change without notice. Review every transaction before signing.

Autonomous stablecoin yield for AI agents and machines. Deposit USDC into the [Robot Money vault](https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd) on Base, earn blended yield diversified across Morpho, Aave, and Compound, withdraw in a single transaction.

## Overview

**robotmoney-cli** — A conversational skill that lets Claude (or any skill/plugin-compatible agent) query the Robot Money vault and prepare unsigned transactions. Check APY, read positions, deposit, redeem. Optional bring-your-own-wallet via [Open Wallet Standard](https://openwallet.sh/) (OWS) for agents that don't have one yet.

Every deposit auto-splits **95% to the vault + 5% across a fixed 6-token agent basket** (VIRTUAL, ROBOT, BNKR, JUNO, ZFI, GIZA) atomically via Uniswap UniversalRouter on Base. Basket tokens land directly in the receiver's wallet — no share token, no claim. See [`references/basket.md`](plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md) for the full token list, defaults, flags, and response shapes.

## Quickstart

### Claude Code

```bash
/plugin marketplace add robotmoney/robotmoney-skills
/plugin install robotmoney-cli@robotmoney
```

### Direct CLI use (any agent runtime, or no framework)

```bash
npx @robotmoney/cli <command> --chain base
```

Works with Cursor, Codex, any MCP-compatible agent that can invoke a shell, or direct terminal use.

## What your agent or machine can do

| Command | Description |
|---|---|
| **WALLET** | |
| `create-wallet` | Bootstrap a new Open Wallet Standard (OWS) wallet for an agent or machine without one |
| **READ** | |
| `health-check` | Check RPC connectivity and vault reachability |
| `get-vault` | Get full vault state: caps, fees, share price, totals; `--verbose` for per-adapter breakdown |
| `get-balance` | Get a user's rmUSDC balance and USDC-equivalent value |
| `get-apy` | Get blended APY across Morpho, Aave, and Compound |
| `get-basket-holdings` | Get all 6 basket-token balances for a user + per-token USDC valuation |
| **PREPARE** (unsigned calldata — caller signs externally) | |
| `prepare-deposit` | Prepare an unsigned deposit (95% vault + 5% basket). Flags: `--no-basket`, `--basket-only`, `--slippage-bps` |
| `prepare-redeem` | Prepare an unsigned redeem + optional basket sells. Flags: `--sell-all`, `--sell-percent`, `--sell-tokens`, `--sell-amounts`. `--shares 0` skips vault leg |
| `prepare-withdraw` | Prepare an unsigned withdrawal by target net USDC + optional basket sells (same flags as redeem). `--amount 0` skips vault leg |
| **EXECUTE** (sign + broadcast end-to-end via OWS) | |
| `execute-deposit` | Sign and broadcast a deposit (vault + basket) via an OWS wallet — returns confirmed tx hashes |
| `execute-redeem` | Sign and broadcast a redeem + optional basket sells via an OWS wallet |
| `execute-withdraw` | Sign and broadcast a withdrawal + optional basket sells via an OWS wallet |

See [`plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`](plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md) for the skill definition and `references/` for response schemas.

## Example — end-to-end deposit via OWS (no external wallet needed)

```bash
# 1. Bootstrap a wallet
npx @robotmoney/cli create-wallet --label my-agent

# 2. Fund the printed address with USDC + a small amount of ETH for gas on Base
#    (Coinbase withdrawal, https://bridge.base.org, or any Base-capable CEX/DEX)

# 3. Execute the deposit — signs + broadcasts + waits for confirmation
npx @robotmoney/cli execute-deposit \
  --chain base \
  --wallet my-agent \
  --amount 100

# 4. Check the new rmUSDC balance
npx @robotmoney/cli get-balance --chain base --user-address <address from step 1>
```

## Example — prepare-only (you sign with your own wallet)

```bash
# 1. Prepare unsigned transactions
npx @robotmoney/cli prepare-deposit \
  --chain base \
  --user-address 0xYourAddress \
  --amount 100 \
  --receiver 0xYourAddress

# 2. Sign and broadcast the returned transactions with your wallet
#    (hardware wallet, Safe, Fireblocks, Coinbase, etc.)

# 3. Check your balance
npx @robotmoney/cli get-balance --chain base --user-address 0xYourAddress
```

## Example — withdraw

```bash
# OWS-signed one-liner (preferred if you created the wallet via create-wallet)
npx @robotmoney/cli execute-redeem --chain base --wallet my-agent --shares max

# Or prepare-only (sign externally)
npx @robotmoney/cli prepare-redeem \
  --chain base \
  --user-address 0xYourAddress \
  --shares max \
  --receiver 0xYourAddress
```

## Architecture

The CLI is a thin client around a single ERC-4626 vault on Base, plus an optional 5% leg through Uniswap UniversalRouter for the agent-token basket:

```
Agent / machine
  │  npx @robotmoney/cli prepare-deposit --amount 100
  ▼
CLI prepares an unsigned tx sequence:
  ├─ 95% vault leg
  │    USDC.approve(vault) + vault.deposit  →  Morpho / Aave / Compound
  └─ 5% basket leg (atomic)
       USDC.approve(Permit2) + Permit2.approve(UR) + UR.execute()
       UniversalRouter routes through V3 + V4 (incl. ROBOT's Doppler hook)
       Basket tokens land directly in receiver wallet
  │  returns JSON with calldata + simulation + per-token quotes
  ▼
Caller signs with their own wallet (externally)
  ▼
Transactions broadcast to Base — vault leg + basket leg commit independently
```

The CLI never holds keys. Your wallet signs externally — the CLI only emits unsigned calldata.

## RPC configuration

By default the CLI rotates across a built-in pool of 5 free Base mainnet endpoints with automatic failover (via viem's `fallback` transport). Users don't need to know what an RPC URL is — it just works.

To override with your own endpoint (Alchemy, QuickNode, etc.):

```bash
# Flag (highest priority)
npx @robotmoney/cli get-vault --chain base --rpc-url https://base-mainnet.g.alchemy.com/v2/<key>

# Environment variable
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> npx @robotmoney/cli get-vault --chain base
```

## Wallet onboarding (OWS)

If your agent or machine doesn't have a wallet, run:

```bash
npx @robotmoney/cli create-wallet --label my-agent
```

This creates an [Open Wallet Standard](https://openwallet.sh/) (OWS) wallet — a cross-chain standard launched by MoonPay in 2026 with backing from PayPal, Base, Circle, Ethereum Foundation, Polygon, and others. Wallets are encrypted locally in `~/.ows/wallets/` and use policy-gated signing (the signing engine enforces rules before touching any key material).

**Fund the wallet with TWO things** before running `execute-*`:
- **USDC** on Base — the amount you want to deposit
- **A small amount of ETH on Base for gas** — ~$0.01–0.05 covers roughly 10 vault transactions

Then run `execute-deposit` (or `execute-redeem` / `execute-withdraw`) to sign and broadcast end-to-end. The CLI reads the keystore via OWS, builds the EIP-1559 envelope, signs via OWS's policy-gated flow, broadcasts to Base, and returns confirmed tx hashes.

```bash
npx @robotmoney/cli execute-deposit --chain base --wallet my-agent --amount 100
```

**Passphrase:** pass via `--passphrase <string>`, `OWS_PASSPHRASE` env var, or leave empty and the CLI will prompt interactively.

**Platform support:** OWS ships native bindings for darwin + linux x64/arm64-gnu. Windows and linux-musl users can still use `prepare-*` (which doesn't load OWS), but `create-wallet` and `execute-*` will error at runtime.

## Contract addresses (Base mainnet)

| Contract | Address |
|---|---|
| **RobotMoneyVault** | [`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`](https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| MorphoAdapter | [`0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9`](https://basescan.org/address/0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9) |
| AaveV3Adapter | [`0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea`](https://basescan.org/address/0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea) |
| CompoundV3Adapter | [`0x8247da22a59fce074c102431048d0ce7294c2652`](https://basescan.org/address/0x8247da22a59fce074c102431048d0ce7294c2652) |

All contracts verified on BaseScan.

## Vault mechanics

- **Deposits** mint rmUSDC shares and atomically route USDC to all active adapters by equal weight
- **Withdrawals** burn rmUSDC and return USDC in a single transaction, minus a 0.25% exit fee
- **Share price** grows over time as yield accrues in the underlying protocols — no rebasing, no rebalancing delays
- **No cooldown, no lock** — deposit and withdraw are synchronous, one transaction each
- **Caps at soft launch:** 500 USDC TVL, 100 USDC per-deposit — these increase with audit + multisig handover

## Basket leg

Every deposit additionally allocates 5% (default, configurable via `--no-basket` / `--basket-only`) across a fixed 6-token agent basket:

| Symbol | Address | Path | Notes |
|---|---|---|---|
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | V3 USDC, fee=3000 | Virtuals Protocol |
| ROBOT | `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` | USDC→WETH (V3 fee=500) → ROBOT (V4 dynamic-fee hook) | Bankr/Doppler launch |
| BNKR | `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b` | USDC→WETH (V3 500) → BNKR (V3 10000) | BankrCoin |
| JUNO | `0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07` | V3 USDC, fee=10000 | Juno Agent |
| ZFI | `0xD080eD3c74a20250a2c9821885203034ACD2D5ae` | USDC→WETH (V3 500) → ZFI (V3 10000) | ZyFAI |
| GIZA | `0x590830dFDf9A3F68aFCDdE2694773dEBDF267774` | USDC→WETH (V3 500) → GIZA (V3 10000) | Giza |

Routes are routed via Uniswap UniversalRouter on Base, atomic in one `execute()` call. Default basket slippage is 3% (`--slippage-bps 300`); each leg's quote and minOut are returned in the prepare-* output. See [`references/basket.md`](plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md) for the full spec including sell flags and Permit2 approval flow.

See [robotmoney.net](https://robotmoney.net) for full protocol details.

## Repo structure

```
robotmoney-skills/
├── plugins/
│   └── robotmoney-cli/
│       ├── plugin.json
│       └── skills/
│           └── robotmoney-cli/
│               ├── SKILL.md              # what the LLM reads
│               └── references/           # JSON schema docs
├── packages/
│   └── cli/                              # the @robotmoney/cli npm package
│       ├── package.json
│       └── src/
└── .claude-plugin/
    └── marketplace.json                  # Claude Code plugin marketplace manifest
```

## Development

```bash
pnpm install
pnpm --filter @robotmoney/cli build
pnpm --filter @robotmoney/cli test

# Run without building
pnpm --filter @robotmoney/cli dev -- get-vault --chain base --rpc-url $RPC_URL
```

## Links

- **Website:** https://robotmoney.net
- **Vault on BaseScan:** https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
- **npm package:** https://www.npmjs.com/package/@robotmoney/cli
- **Open Wallet Standard:** https://openwallet.sh/

## License

MIT
