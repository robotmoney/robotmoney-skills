import { emitJson } from '../lib/format.js';
import { owsCreateWallet } from '../lib/wallet.js';

export interface CreateWalletOptions {
  label?: string | undefined;
  storagePath?: string | undefined;
  passphrase?: string | undefined;
  pretty?: boolean | undefined;
}

export async function createWallet(options: CreateWalletOptions = {}): Promise<void> {
  const result = await owsCreateWallet({
    label: options.label,
    storagePath: options.storagePath,
    passphrase: options.passphrase,
  });

  emitJson(
    {
      provider: 'ows',
      providerVersion: result.providerVersion,
      address: result.address,
      chain: 'base',
      name: result.name,
      storagePath: result.storagePath,
      instructions: [
        '1. Your wallet has been created and encrypted at the storage path above.',
        '2. Fund it with USDC on Base. Options:',
        '   - Coinbase: withdraw USDC to your address, select Base network',
        '   - Bridge: https://bridge.base.org',
        '   - Any CEX/DEX that supports Base withdrawals',
        `3. Prepare a deposit with: robotmoney prepare-deposit --chain base --user-address ${result.address} --amount 100 --receiver ${result.address}`,
        '4. Pass --wallet <storagePath> to prepare-* commands to sign via OWS policy-gated flow.',
      ],
      fundingOptions: [
        { method: 'coinbase-direct', description: 'Withdraw USDC from Coinbase to this address on Base' },
        { method: 'base-bridge', url: 'https://bridge.base.org' },
        { method: 'dex-swap', description: 'Swap any Base token for USDC via Uniswap or Aerodrome' },
      ],
    },
    { pretty: options.pretty ?? false },
  );
}
