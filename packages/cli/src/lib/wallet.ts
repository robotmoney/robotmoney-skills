import type { Address, Hex } from 'viem';

/**
 * Thin lazy wrapper around @open-wallet-standard/core.
 *
 * The OWS dependency is optional — we import it dynamically inside these
 * functions so users who never run `create-wallet` or pass `--wallet` never
 * pay the install cost and never hit native-binding issues on unsupported
 * platforms (Windows / linux-musl).
 */

interface OwsAccount {
  chainId: string;
  address: string;
  derivationPath?: string;
}

interface OwsWalletInfo {
  name: string;
  accounts: OwsAccount[];
}

interface OwsCore {
  createWallet: (
    name: string,
    passphrase?: string,
    words?: number,
    vaultPathOpt?: string,
  ) => OwsWalletInfo;
  signTransaction: (
    wallet: string,
    chain: string,
    txHex: string,
    passphrase?: string,
    index?: number,
    vaultPathOpt?: string,
  ) => { signature: string; recoveryId?: number };
  listWallets: (vaultPathOpt?: string) => OwsWalletInfo[];
  getWallet: (name: string, vaultPathOpt?: string) => OwsWalletInfo | null;
}

async function loadOws(): Promise<OwsCore> {
  try {
    const mod = (await import('@open-wallet-standard/core')) as unknown as OwsCore;
    return mod;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load @open-wallet-standard/core. Install with: ` +
        `pnpm add @open-wallet-standard/core@1.2.4 ` +
        `(note: native bindings only ship for darwin/linux-x64/arm64-gnu). ` +
        `Underlying error: ${message}`,
    );
  }
}

export interface CreateWalletResult {
  address: Address;
  name: string;
  storagePath: string;
  providerVersion: string;
}

export async function owsCreateWallet(opts: {
  label?: string | undefined;
  storagePath?: string | undefined;
  passphrase?: string | undefined;
}): Promise<CreateWalletResult> {
  const ows = await loadOws();
  const name = opts.label ?? `robotmoney-agent-${Date.now()}`;
  const info = ows.createWallet(name, opts.passphrase, undefined, opts.storagePath);

  const evm = info.accounts.find((a) => a.chainId?.startsWith('eip155:'));
  if (!evm) throw new Error('OWS wallet created but no EVM account was derived.');

  return {
    address: evm.address as Address,
    name: info.name,
    storagePath: opts.storagePath ?? '~/.ows/wallets/',
    providerVersion: '1.2.4',
  };
}

export async function owsSignTransaction(opts: {
  walletName: string;
  rlpTxHex: Hex;
  passphrase?: string | undefined;
  storagePath?: string | undefined;
}): Promise<{ signature: Hex; recoveryId?: number }> {
  const ows = await loadOws();
  const result = ows.signTransaction(
    opts.walletName,
    'evm',
    opts.rlpTxHex,
    opts.passphrase,
    0,
    opts.storagePath,
  );
  const out: { signature: Hex; recoveryId?: number } = { signature: result.signature as Hex };
  if (typeof result.recoveryId === 'number') out.recoveryId = result.recoveryId;
  return out;
}
