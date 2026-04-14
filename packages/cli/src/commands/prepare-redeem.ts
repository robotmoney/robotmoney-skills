import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseShares } from '../lib/format.js';
import { simulateSequence } from '../lib/simulate.js';
import { checkGasBudget } from '../lib/gas.js';
import type { GlobalFlags } from '../lib/args.js';

export interface PrepareRedeemOptions {
  userAddress: Address;
  shares: string; // "max" or decimal
  receiver: Address;
}

export async function prepareRedeem(
  flags: GlobalFlags,
  options: PrepareRedeemOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];

  let sharesRaw: bigint;
  if (options.shares === 'max') {
    sharesRaw = (await client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [options.userAddress],
    })) as bigint;
  } else {
    sharesRaw = parseShares(options.shares);
  }

  const [gross, net, paused] = (await Promise.all([
    sharesRaw === 0n
      ? Promise.resolve(0n)
      : client.readContract({
          address: addrs.vault,
          abi: VAULT_ABI,
          functionName: 'convertToAssets',
          args: [sharesRaw],
        }),
    sharesRaw === 0n
      ? Promise.resolve(0n)
      : client.readContract({
          address: addrs.vault,
          abi: VAULT_ABI,
          functionName: 'previewRedeem',
          args: [sharesRaw],
        }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
  ])) as [bigint, bigint, boolean];

  const fee = gross >= net ? gross - net : 0n;

  const transactions = [
    {
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'redeem',
        args: [sharesRaw, options.receiver, options.userAddress],
      }),
      value: '0',
      description: `vault.redeem(${sharesRaw.toString()}, ${options.receiver}, ${options.userAddress})`,
    },
  ];

  const warnings: string[] = [];
  if (paused) warnings.push('Vault is paused — redeem is temporarily disabled.');
  if (sharesRaw === 0n) warnings.push('User has 0 rmUSDC shares to redeem.');

  const simulation = await simulateSequence(client, transactions, options.userAddress);

  const gasCheck = await checkGasBudget(
    client,
    options.userAddress,
    BigInt(simulation.gasEstimate || '0'),
  );
  if (gasCheck.error) warnings.push(gasCheck.error);
  else if (gasCheck.warning) warnings.push(gasCheck.warning);

  emitJson(
    {
      operation: {
        type: 'redeem',
        summary: `Redeem ${formatShares(sharesRaw)} rmUSDC → ${formatUsdc(net)} USDC to ${options.receiver} (after ${formatUsdc(fee)} exit fee)`,
        transactions,
        warnings,
      },
      simulation: {
        ...simulation,
        preview: {
          sharesRaw: sharesRaw.toString(),
          grossUsdc: formatUsdc(gross),
          feeUsdc: formatUsdc(fee),
          netUsdc: formatUsdc(net),
          netUsdcRaw: net.toString(),
        },
      },
    },
    { pretty: flags.pretty ?? false },
  );
}
