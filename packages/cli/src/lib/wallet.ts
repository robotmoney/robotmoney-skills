import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Address, Hex } from 'viem';

/**
 * Thin lazy wrapper around @open-wallet-standard/core.
 *
 * The OWS dependency is imported dynamically so users who never run
 * `create-wallet` or an `execute-*` command never pay the native-binding
 * load cost, and callers on unsupported platforms (Windows / linux-musl)
 * can still use prepare-* without tripping a load error at startup.
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
  signAndSend: (
    wallet: string,
    chain: string,
    txHex: string,
    passphrase?: string,
    index?: number,
    rpcUrl?: string,
    vaultPathOpt?: string,
  ) => { txHash: string };
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
      'Failed to load @open-wallet-standard/core. This platform may not have OWS native bindings ' +
        '(OWS ships prebuilts only for darwin + linux x64/arm64-gnu). Fall back to prepare-* ' +
        `commands and sign externally. Underlying error: ${message}`,
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

export const DEFAULT_OWS_VAULT_PATH = join(homedir(), '.ows', 'wallets');

/**
 * Resolve which OWS wallet to use for an execute-* command.
 *  - Explicit `--wallet <name>` wins
 *  - Else if exactly one wallet exists in the vault dir, use it
 *  - Else: error out with a helpful message
 */
export async function resolveWallet(opts: {
  walletName?: string | undefined;
  storagePath?: string | undefined;
}): Promise<{ name: string; address: Address; storagePath: string }> {
  const ows = await loadOws();
  const vaultPath = opts.storagePath ?? DEFAULT_OWS_VAULT_PATH;

  if (opts.walletName) {
    const info = ows.getWallet(opts.walletName, opts.storagePath);
    if (!info) {
      throw new Error(
        `OWS wallet "${opts.walletName}" not found in ${vaultPath}. ` +
          `Run \`robotmoney create-wallet --label ${opts.walletName}\` first, or list existing wallets.`,
      );
    }
    const evm = info.accounts.find((a) => a.chainId?.startsWith('eip155:'));
    if (!evm) throw new Error(`Wallet "${opts.walletName}" has no EVM account derived.`);
    return { name: info.name, address: evm.address as Address, storagePath: vaultPath };
  }

  // No explicit name — try auto-pick if exactly one wallet exists
  let entries: string[] = [];
  try {
    entries = await readdir(vaultPath);
  } catch {
    throw new Error(
      `No OWS vault directory found at ${vaultPath}. Run \`robotmoney create-wallet\` first, ` +
        `or pass --wallet <name> pointing at an existing wallet.`,
    );
  }
  const wallets = ows.listWallets(opts.storagePath);
  if (wallets.length === 0) {
    throw new Error(
      `No OWS wallets found in ${vaultPath}. Run \`robotmoney create-wallet\` first.`,
    );
  }
  if (wallets.length > 1) {
    const names = wallets.map((w) => w.name).join(', ');
    throw new Error(
      `Multiple OWS wallets found (${names}). Pass --wallet <name> to disambiguate.`,
    );
  }
  const only = wallets[0]!;
  const evm = only.accounts.find((a) => a.chainId?.startsWith('eip155:'));
  if (!evm) throw new Error(`Wallet "${only.name}" has no EVM account derived.`);
  return { name: only.name, address: evm.address as Address, storagePath: vaultPath };
}

/**
 * Passphrase resolution: flag > env > interactive TTY prompt.
 * Throws if no TTY is attached and no flag/env is provided.
 */
export async function resolvePassphrase(opts: {
  passphraseFlag?: string | undefined;
}): Promise<string | undefined> {
  if (opts.passphraseFlag !== undefined) return opts.passphraseFlag;
  const env = process.env.OWS_PASSPHRASE;
  if (env && env.length > 0) return env;

  if (!process.stdin.isTTY) {
    throw new Error(
      'OWS passphrase required. Pass --passphrase <string>, set OWS_PASSPHRASE in the environment, ' +
        'or run the command in a TTY to be prompted.',
    );
  }

  return new Promise<string | undefined>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write('OWS passphrase (leave empty if wallet has none): ');
    // Ideally we'd hide input, but Node's readline doesn't support that portably
    // without extra deps. Writing to stderr keeps stdout clean for JSON output.
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.length > 0 ? answer : undefined);
    });
  });
}

/**
 * Sign and broadcast a viem-serialized EIP-1559 envelope via OWS.
 * `serializedTx` must be the full typed-transaction envelope (0x02 || RLP(fields)),
 * exactly what viem's `serializeTransaction` returns. OWS does not populate
 * nonce, gas, or chainId — those must be pre-filled before calling.
 */
export async function owsSignAndSend(opts: {
  walletName: string;
  serializedTx: Hex;
  passphrase?: string | undefined;
  rpcUrl: string;
  storagePath?: string | undefined;
}): Promise<{ txHash: Hex }> {
  const ows = await loadOws();
  const result = ows.signAndSend(
    opts.walletName,
    'evm',
    opts.serializedTx,
    opts.passphrase,
    0,
    opts.rpcUrl,
    opts.storagePath,
  );
  return { txHash: result.txHash as Hex };
}
