# @robotmoney/cli

> **Experimental** — pre-v1.0. Command syntax and response schemas may change. Always review transactions before signing.

CLI for the [Robot Money](https://robotmoney.net) stablecoin yield vault on Base. Built for AI agents and autonomous machines — every command emits JSON to stdout.

## Install

```bash
# One-off use
npx @robotmoney/cli <command> --chain base

# Or as a project dependency
npm install @robotmoney/cli
```

## Quickstart

```bash
# Read vault state
npx @robotmoney/cli get-vault --chain base

# Get blended APY across Morpho, Aave, Compound
npx @robotmoney/cli get-apy --chain base

# Prepare an unsigned deposit (includes USDC approval automatically)
npx @robotmoney/cli prepare-deposit \
  --chain base \
  --user-address 0xYourAddress \
  --amount 100 \
  --receiver 0xYourAddress

# Prepare a one-tx redeem
npx @robotmoney/cli prepare-redeem \
  --chain base \
  --user-address 0xYourAddress \
  --shares max \
  --receiver 0xYourAddress
```

## Commands

| Command | Description |
|---|---|
| `create-wallet` | Bootstrap a new Open Wallet Standard wallet |
| `health-check` | Check RPC connectivity and vault reachability |
| `get-vault` | Full vault state (caps, fees, share price); `--verbose` adds per-adapter breakdown |
| `get-balance` | A user's rmUSDC balance and USDC-equivalent value |
| `get-apy` | Blended APY across Morpho, Aave, and Compound |
| `prepare-deposit` | Unsigned deposit tx with auto-included USDC approval |
| `prepare-redeem` | Unsigned one-tx redeem; accepts `--shares max` |
| `prepare-withdraw` | Unsigned withdrawal by target net USDC amount |

## RPC configuration

```bash
# Flag (highest priority)
npx @robotmoney/cli get-vault --chain base --rpc-url https://base-mainnet.g.alchemy.com/v2/<key>

# Environment variable
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> npx @robotmoney/cli get-vault --chain base
```

Without a flag or env var, falls back to `https://base.llamarpc.com` (rate-limited — configure your own RPC for anything beyond occasional calls).

## Full docs

- Skill definition + LLM-facing docs: [`SKILL.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md)
- Read schemas: [`references/read.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/read.md)
- Write schemas: [`references/write.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md)
- Repo: https://github.com/robotmoney/robotmoney-skills

## License

MIT
