# Robot Money Skills

> **Experimental** — This project is pre-v1.0. Command syntax, response schemas, and behavior may change without notice. Review every transaction before signing.

Autonomous stablecoin yield for AI agents and machines. Deposit USDC into the [Robot Money vault](https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd) on Base, earn blended yield diversified across Morpho, Aave, and Compound, withdraw in a single transaction.

## Overview

**robotmoney-cli** — A conversational skill that lets Claude (or any skill/plugin-compatible agent) query the Robot Money vault and prepare unsigned transactions. Check APY, read positions, deposit, redeem. Optional bring-your-own-wallet via [Open Wallet Standard](https://openwallet.sh/) (OWS) for agents that don't have one yet.

## Quickstart

### Claude Code

```bash
/plugin marketplace add robotmoney/robotmoney-skills
/plugin install robotmoney-cli@robotmoney
```

### Any other agent runtime

```bash
npx skills add robotmoney/robotmoney-skills --skill robotmoney-cli
```

### Direct CLI use (no agent framework)

```bash
npx @robotmoney/cli <command> --chain base
```

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
| **WRITE** | |
| `prepare-deposit` | Prepare an unsigned deposit with auto-included USDC approval |
| `prepare-redeem` | Prepare an unsigned synchronous redeem (one-tx withdrawal, `--shares max` supported) |
| `prepare-withdraw` | Prepare an unsigned withdrawal by target net USDC amount |

See [`plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`](plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md) for the skill definition and `references/` for response schemas.

## Example — full deposit flow

```bash
# 1. Check vault status
npx @robotmoney/cli get-vault --chain base

# 2. (optional) Create a wallet if you don't have one
npx @robotmoney/cli create-wallet

# 3. Check current APY
npx @robotmoney/cli get-apy --chain base

# 4. Prepare a 100 USDC deposit (auto-includes USDC approval)
npx @robotmoney/cli prepare-deposit \
  --chain base \
  --user-address 0xYourAddress \
  --amount 100 \
  --receiver 0xYourAddress

# 5. Sign and broadcast the returned transactions with your wallet
#    (or pass --wallet <path> to sign via OWS automatically)

# 6. Check your balance
npx @robotmoney/cli get-balance --chain base --user-address 0xYourAddress
```

## Example — withdraw

```bash
# Redeem all shares (one transaction, get USDC immediately minus 0.25% exit fee)
npx @robotmoney/cli prepare-redeem \
  --chain base \
  --user-address 0xYourAddress \
  --shares max \
  --receiver 0xYourAddress
```

## Architecture

The CLI is a thin client around a single ERC-4626 vault on Base:

```
Agent / machine
  │  npx @robotmoney/cli prepare-deposit
  ▼
CLI prepares unsigned tx + runs eth_call simulation
  │  returns JSON with calldata + preview
  ▼
Caller signs (via own wallet OR via OWS policy-gated signing if --wallet passed)
  ▼
Transaction broadcasts to Base
  ▼
Vault splits USDC atomically across:
  • Morpho Gauntlet USDC Prime
  • Aave V3 USDC
  • Compound V3 cUSDCv3
```

The CLI never holds keys. Either your wallet signs externally, or OWS signs with its policy-gated flow — in both cases, the CLI only emits or triggers calldata, it doesn't own secrets.

## RPC configuration

By default the CLI uses `https://base.llamarpc.com` as a fallback public RPC. This is rate-limited and only suitable for occasional calls. For anything beyond that, configure your own:

```bash
# Flag (highest priority)
npx @robotmoney/cli get-vault --chain base --rpc-url https://base-mainnet.g.alchemy.com/v2/<key>

# Environment variable
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> npx @robotmoney/cli get-vault --chain base
```

## Wallet onboarding (OWS)

If your agent or machine doesn't have a wallet, run:

```bash
npx @robotmoney/cli create-wallet
```

This creates an [Open Wallet Standard](https://openwallet.sh/) wallet — a cross-chain standard launched by MoonPay in 2026 with backing from PayPal, Base, Circle, Ethereum Foundation, Polygon, and others. Wallets are encrypted locally and use policy-gated signing (the signing engine enforces rules before touching any key material).

Once you have a wallet, pass `--wallet <path>` to any `prepare-*` command and the CLI will sign and broadcast automatically.

The `@open-wallet-standard/core` SDK is an **optional** dependency and ships native bindings only for darwin/linux x64/arm64. Users who never call `create-wallet` or `--wallet` never load it.

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
- **Main repo (contracts + server):** https://github.com/robotmoney/robo-money
- **Open Wallet Standard:** https://openwallet.sh/

## License

MIT
