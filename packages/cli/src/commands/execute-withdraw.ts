import { encodeFunctionData, type Address } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { resolveWallet, resolvePassphrase } from '../lib/wallet.js';
import { signAndSendSequence, resolveBroadcastRpcUrl } from '../lib/execute.js';
import { checkGasBudget } from '../lib/gas.js';
import type { UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface ExecuteWithdrawOptions {
  amount: string; // net USDC target
  wallet?: string | undefined;
  passphrase?: string | undefined;
  storagePath?: string | undefined;
  receiver?: Address | undefined;
}

export async function executeWithdraw(
  flags: GlobalFlags,
  options: ExecuteWithdrawOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const netUsdc = parseUsdc(options.amount);

  const wallet = await resolveWallet({
    walletName: options.wallet,
    storagePath: options.storagePath,
  });
  const receiver = options.receiver ?? wallet.address;
  const passphrase = await resolvePassphrase({ passphraseFlag: options.passphrase });
  const rpcUrl = await resolveBroadcastRpcUrl(flags);

  const [sharesNeeded, grossUsdc, paused] = (await Promise.all([
    client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'previewWithdraw',
      args: [netUsdc],
    }),
    client
      .readContract({
        address: addrs.vault,
        abi: VAULT_ABI,
        functionName: 'previewWithdraw',
        args: [netUsdc],
      })
      .then((shares) =>
        client.readContract({
          address: addrs.vault,
          abi: VAULT_ABI,
          functionName: 'convertToAssets',
          args: [shares as bigint],
        }),
      ),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
  ])) as [bigint, bigint, boolean];

  if (paused) throw new Error('Vault is paused \u2014 withdraw is temporarily disabled.');

  const transactions: UnsignedTx[] = [
    {
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [netUsdc, receiver, wallet.address],
      }),
      value: '0',
      description: `vault.withdraw(${netUsdc.toString()}, ${receiver}, ${wallet.address})`,
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

  const fee = grossUsdc >= netUsdc ? grossUsdc - netUsdc : 0n;

  emitJson(
    {
      operation: {
        type: 'withdraw',
        summary: `Withdrew ${formatUsdc(netUsdc)} USDC (burn ~${formatShares(sharesNeeded)} rmUSDC) via OWS wallet "${wallet.name}"`,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview: {
        sharesBurned: formatShares(sharesNeeded),
        grossUsdc: formatUsdc(grossUsdc),
        feeUsdc: formatUsdc(fee),
        netUsdc: formatUsdc(netUsdc),
      },
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
