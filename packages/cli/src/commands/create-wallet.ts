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
        '2. Fund it on Base with TWO things:',
        '   a. USDC — the amount you want to deposit (the vault per-deposit cap is 5,000 USDC).',
        '   b. A small amount of ETH for gas (~$0.01\u2013$0.05 covers roughly 10 vault transactions).',
        '   Funding options: Coinbase withdraw on Base, https://bridge.base.org, or any CEX/DEX that supports Base.',
        `3. Execute a deposit end-to-end via OWS with: robotmoney execute-deposit --chain base --wallet ${result.name} --amount <usdc>`,
        `4. Or, to inspect the unsigned transactions first: robotmoney prepare-deposit --chain base --user-address ${result.address} --amount <usdc> --receiver ${result.address}`,
      ],
      fundingOptions: [
        {
          method: 'coinbase-direct',
          description: 'Withdraw USDC and ETH from Coinbase to this address on Base (Base network).',
        },
        { method: 'base-bridge', url: 'https://bridge.base.org' },
        { method: 'dex-swap', description: 'Swap any Base token for USDC via Uniswap or Aerodrome.' },
      ],
      gasNote:
        'Every vault transaction on Base costs a small amount of ETH for gas (~$0.01\u2013$0.05). Make sure the wallet holds ETH in addition to USDC.',
    },
    { pretty: options.pretty ?? false },
  );
}
