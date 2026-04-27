# Changelog

All notable changes to `@robotmoney/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-04-27

### Added
- **Agent basket leg** on every deposit, redeem, and withdraw. `prepare-deposit` / `execute-deposit` now split the input 95% to the vault + 5% across a fixed 6-token basket (VIRTUAL, ROBOT, BNKR, JUNO, ZFI, GIZA), atomically via Uniswap UniversalRouter on Base. Tokens land directly in the receiver's wallet — no share token. Pool routing was discovered on-chain (V3 for 5 tokens; V3→V4 multi-hop for ROBOT via its Doppler-deployed dynamic-fee hook). See `references/basket.md`.
- **`get-basket-holdings`** command — read every basket-token balance for a user plus per-token USDC valuation via on-chain quotes. Pass `--no-pricing` to skip the quoter calls.
- **New deposit flags**: `--no-basket` (vault-only), `--basket-only` (skip vault leg), `--slippage-bps` (default 300 = 3%, applied uniformly across V3 and Clanker dynamic-fee V4 pools).
- **New redeem/withdraw flags**: `--sell-all`, `--sell-percent N` (1-100), `--sell-tokens VIRTUAL,JUNO`, `--sell-amounts 1.5,200` (parallel to `--sell-tokens`). Pass `--shares 0` (or `--amount 0` on withdraw) to skip the vault leg and only sell basket tokens.
- **Permit2 approval flow** auto-emitted when missing or expired (max amount, 1y expiration). Steady-state cost: 1 tx for a deposit after first use, since approvals carry over.
- **Quote validity window** of 5 minutes embedded as the UR `execute()` deadline. Response includes `validUntil` for callers to re-quote if signing takes longer.

### Changed
- **Default behavior**: a deposit at `--amount N` now allocates 95% to the vault and 5% across the basket. Old vault-only behavior is preserved with `--no-basket`. Callers parsing `operation.transactions` should expect more entries (up to 5 in the worst-case fresh-Permit2 case).
- `prepare-redeem` and `prepare-withdraw` now accept `--shares 0` and `--amount 0` respectively to mean "skip the vault leg" (basket-sell only).

## [0.1.2] — 2026-04-14

### Added
- **`execute-deposit`, `execute-redeem`, `execute-withdraw`** — new commands that sign and broadcast end-to-end via an Open Wallet Standard (OWS) wallet. Return confirmed transaction hashes instead of unsigned calldata.
- **Wallet resolution ladder** — `--wallet <name>` flag, or auto-pick if exactly one OWS wallet exists in `~/.ows/wallets/`.
- **Passphrase resolution ladder** — `--passphrase <string>`, `OWS_PASSPHRASE` env var, or interactive TTY prompt.
- **RPC fallback pool** — built-in rotation across 5 free Base endpoints via viem's `fallback()` transport, with automatic retry on rate-limits. Users no longer need to know what an RPC URL is.
- **ETH-for-gas balance check** in every `prepare-*` and `execute-*` command. Warns in prepare, hard-errors in execute when the wallet lacks enough ETH.
- Updated `create-wallet` output: now tells users to fund with USDC *and* a small amount of ETH for gas on Base.

### Fixed
- **Gas estimate was 33x too low** on `prepare-deposit` because simulation ran against latest block (pre-approval), reverting at the allowance check and reporting tiny gas. Now uses viem's `stateOverride` to pre-apply the USDC allowance at storage slot 10 (verified against the Circle FiatTokenV2_2 implementation on Base), yielding the correct ~1.8M gas for routing across 3 adapters.
- **Spurious pre-approval simulation failures** — with the state override in place, the deposit simulation no longer reports a false `ERC20InsufficientAllowance` failure. In the rare case state override can't be applied, the failure is now labeled `expected: true` and doesn't flip `allSucceeded`.

### Changed
- `@open-wallet-standard/core` promoted from `optionalDependencies` to `dependencies`. `create-wallet` and `execute-*` are now first-class rather than opt-in install steps. Windows/musl remain unsupported at runtime for those commands; `prepare-*` still works everywhere.

## [0.1.1] — 2026-04-14

### Fixed
- `prepare-withdraw` and `prepare-redeem` now decode OpenZeppelin ERC-4626 custom errors (`ERC4626ExceededMaxWithdraw`, `ERC4626ExceededMaxRedeem`, etc.) instead of reporting "unknown reason" when simulation fails.
- Decode OpenZeppelin ERC-20 custom errors (`ERC20InsufficientAllowance`, `ERC20InsufficientBalance`) in simulation failures.

### Changed
- Documentation corrected: removed references to a `--wallet` flag and a `npx skills add` command that were not implemented. Wallet-signing via OWS remains on the v0.2 roadmap.

## [0.1.0] — 2026-04-14

Initial release.
