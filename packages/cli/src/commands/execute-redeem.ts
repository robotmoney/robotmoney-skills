import { encodeFunctionData, type Address } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseShares } from '../lib/format.js';
import { resolveWallet, resolvePassphrase } from '../lib/wallet.js';
import { signAndSendSequence, resolveBroadcastRpcUrl } from '../lib/execute.js';
import { checkGasBudget } from '../lib/gas.js';
import type { UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface ExecuteRedeemOptions {
  shares: string; // "max" or decimal
  wallet?: string | undefined;
  passphrase?: string | undefined;
  storagePath?: string | undefined;
  receiver?: Address | undefined;
}

export async function executeRedeem(
  flags: GlobalFlags,
  options: ExecuteRedeemOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];

  const wallet = await resolveWallet({
    walletName: options.wallet,
    storagePath: options.storagePath,
  });
  const receiver = options.receiver ?? wallet.address;
  const passphrase = await resolvePassphrase({ passphraseFlag: options.passphrase });
  const rpcUrl = await resolveBroadcastRpcUrl(flags);

  let sharesRaw: bigint;
  if (options.shares === 'max') {
    sharesRaw = (await client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint;
  } else {
    sharesRaw = parseShares(options.shares);
  }
  if (sharesRaw === 0n) throw new Error('No shares to redeem (balance is 0).');

  const [grossAssets, netAssets, paused] = (await Promise.all([
    client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'convertToAssets',
      args: [sharesRaw],
    }),
    client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'previewRedeem',
      args: [sharesRaw],
    }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
  ])) as [bigint, bigint, boolean];

  if (paused) throw new Error('Vault is paused \u2014 redeem is temporarily disabled.');

  const transactions: UnsignedTx[] = [
    {
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'redeem',
        args: [sharesRaw, receiver, wallet.address],
      }),
      value: '0',
      description: `vault.redeem(${sharesRaw.toString()}, ${receiver}, ${wallet.address})`,
    },
  ];

  const preflightGas = 1_800_000n;
  const gasCheck = await checkGasBudget(client, wallet.address, preflightGas);
  if (gasCheck.error) throw new Error(gasCheck.error);

  const results = await signAndSendSequence(
    {
      client,
      user: wallet.address,
      walletName: wallet.name,
      passphrase,
      rpcUrl,
      ...(options.storagePath !== undefined ? { storagePath: options.storagePath } : {}),
    },
    transactions,
  );

  const fee = grossAssets >= netAssets ? grossAssets - netAssets : 0n;

  emitJson(
    {
      operation: {
        type: 'redeem',
        summary: `Redeemed ${formatShares(sharesRaw)} rmUSDC \u2192 ${formatUsdc(netAssets)} USDC via OWS wallet "${wallet.name}"`,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview: {
        sharesRedeemed: formatShares(sharesRaw),
        grossUsdc: formatUsdc(grossAssets),
        feeUsdc: formatUsdc(fee),
        netUsdc: formatUsdc(netAssets),
      },
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
