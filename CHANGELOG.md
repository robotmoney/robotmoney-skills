# Changelog

All notable changes to `@robotmoney/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-04-14

### Fixed
- `prepare-withdraw` and `prepare-redeem` now decode OpenZeppelin ERC-4626 custom errors (`ERC4626ExceededMaxWithdraw`, `ERC4626ExceededMaxRedeem`, etc.) instead of reporting "unknown reason" when simulation fails.
- Decode OpenZeppelin ERC-20 custom errors (`ERC20InsufficientAllowance`, `ERC20InsufficientBalance`) in simulation failures.

### Changed
- Documentation corrected: removed references to a `--wallet` flag and a `npx skills add` command that were not implemented. Wallet-signing via OWS remains on the v0.2 roadmap.

## [0.1.0] — 2026-04-14

Initial release.
