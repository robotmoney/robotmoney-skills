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

### End-to-end via OWS (no external wallet needed)

```bash
# 1. Bootstrap a wallet
npx @robotmoney/cli create-wallet --label my-agent

# 2. Fund the printed address with USDC + a small amount of ETH for gas on Base

# 3. Execute the deposit (signs + broadcasts via OWS, returns tx hashes)
npx @robotmoney/cli execute-deposit --chain base --wallet my-agent --amount 100
```

### Prepare-only (you sign with your own wallet)

```bash
npx @robotmoney/cli prepare-deposit \
  --chain base \
  --user-address 0xYourAddress \
  --amount 100 \
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
| `execute-deposit` | Sign + broadcast a deposit end-to-end via an OWS wallet |
| `execute-redeem` | Sign + broadcast a redeem end-to-end via an OWS wallet |
| `execute-withdraw` | Sign + broadcast a withdrawal end-to-end via an OWS wallet |

## RPC configuration

The CLI uses a built-in fallback pool of 5 free Base mainnet endpoints by default, with automatic retry across endpoints when any one rate-limits. Override with:

```bash
# Flag (highest priority)
npx @robotmoney/cli get-vault --chain base --rpc-url https://base-mainnet.g.alchemy.com/v2/<key>

# Environment variable
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> npx @robotmoney/cli get-vault --chain base
```

## OWS wallet + passphrase

`execute-*` commands use [Open Wallet Standard](https://openwallet.sh/) to sign.

- `--wallet <name>` — explicit wallet name. If omitted and only one wallet exists in `~/.ows/wallets/`, it's auto-picked.
- `--passphrase <string>` — passphrase flag (shell history hazard)
- `OWS_PASSPHRASE` env var — clean passphrase path for agents
- Otherwise, the CLI prompts interactively on a TTY

## Full docs

- Skill definition + LLM-facing docs: [`SKILL.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md)
- Read schemas: [`references/read.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/read.md)
- Write schemas: [`references/write.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md)
- Repo: https://github.com/robotmoney/robotmoney-skills

## License

MIT
