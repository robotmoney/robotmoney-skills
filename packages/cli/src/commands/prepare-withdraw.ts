import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { simulateSequence } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface PrepareWithdrawOptions {
  userAddress: Address;
  amount: string; // decimal USDC net
  receiver: Address;
}

export async function prepareWithdraw(
  flags: GlobalFlags,
  options: PrepareWithdrawOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const netUsdc = parseUsdc(options.amount);

  const [sharesNeeded, grossUsdc, paused] = (await Promise.all([
    client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'previewWithdraw',
      args: [netUsdc],
    }),
    // grossUsdc needed to compute fee = gross - net. We reverse via previewRedeem(previewWithdraw(x)).
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

  const fee = grossUsdc >= netUsdc ? grossUsdc - netUsdc : 0n;

  const transactions = [
    {
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [netUsdc, options.receiver, options.userAddress],
      }),
      value: '0',
      description: `vault.withdraw(${netUsdc.toString()}, ${options.receiver}, ${options.userAddress})`,
    },
  ];

  const warnings: string[] = [];
  if (paused) warnings.push('Vault is paused — withdraw is temporarily disabled.');

  const simulation = await simulateSequence(client, transactions, options.userAddress);

  emitJson(
    {
      operation: {
        type: 'withdraw',
        summary: `Withdraw ${formatUsdc(netUsdc)} USDC net (burn ~${formatShares(sharesNeeded)} rmUSDC, ${formatUsdc(fee)} exit fee) → ${options.receiver}`,
        transactions,
        warnings,
      },
      simulation: {
        ...simulation,
        preview: {
          sharesRequired: formatShares(sharesNeeded),
          sharesRequiredRaw: sharesNeeded.toString(),
          grossUsdc: formatUsdc(grossUsdc),
          feeUsdc: formatUsdc(fee),
          netUsdc: formatUsdc(netUsdc),
        },
      },
    },
    { pretty: flags.pretty ?? false },
  );
}
