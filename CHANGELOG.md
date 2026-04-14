# Changelog

All notable changes to `@robotmoney/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
