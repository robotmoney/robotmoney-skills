import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { simulateSequence, type UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface PrepareDepositOptions {
  userAddress: Address;
  amount: string; // decimal USDC
  receiver: Address;
  skipApprove?: boolean;
}

export async function prepareDeposit(
  flags: GlobalFlags,
  options: PrepareDepositOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const amountRaw = parseUsdc(options.amount);

  const [currentAllowance, tvlCap, perDepositCap, totalAssets, paused, shutdown] =
    (await Promise.all([
      client.readContract({
        address: addrs.usdc,
        abi: USDC_ABI,
        functionName: 'allowance',
        args: [options.userAddress, addrs.vault],
      }),
      client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'tvlCap' }),
      client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'perDepositCap' }),
      client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'totalAssets' }),
      client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
      client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'shutdown' }),
    ])) as [bigint, bigint, bigint, bigint, boolean, boolean];

  const transactions: UnsignedTx[] = [];
  const needsApproval = !options.skipApprove && currentAllowance < amountRaw;

  if (needsApproval) {
    transactions.push({
      to: addrs.usdc,
      data: encodeFunctionData({
        abi: USDC_ABI,
        functionName: 'approve',
        args: [addrs.vault, amountRaw],
      }),
      value: '0',
      description: `USDC.approve(vault, ${amountRaw.toString()})`,
    });
  }

  transactions.push({
    to: addrs.vault,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [amountRaw, options.receiver],
    }),
    value: '0',
    description: `vault.deposit(${amountRaw.toString()}, ${options.receiver})`,
  });

  const warnings: string[] = [];
  if (shutdown) warnings.push('Vault is shut down — deposits are disabled.');
  if (paused) warnings.push('Vault is paused — deposits are temporarily disabled.');
  if (amountRaw > perDepositCap) {
    warnings.push(
      `Amount ${formatUsdc(amountRaw)} exceeds perDepositCap ${formatUsdc(perDepositCap)}.`,
    );
  }
  if (totalAssets + amountRaw > tvlCap) {
    warnings.push(
      `Deposit would exceed TVL cap (${formatUsdc(tvlCap)}). Current TVL: ${formatUsdc(totalAssets)}.`,
    );
  }

  // previewDeposit works even if simulation would revert on the write path.
  let sharesToMint: bigint | null = null;
  try {
    sharesToMint = (await client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'previewDeposit',
      args: [amountRaw],
    })) as bigint;
  } catch {
    sharesToMint = null;
  }

  const simulation = await simulateSequence(client, transactions, options.userAddress);

  emitJson(
    {
      operation: {
        type: 'deposit',
        summary:
          sharesToMint === null
            ? `Deposit ${options.amount} USDC`
            : `Deposit ${options.amount} USDC → mint ~${formatShares(sharesToMint)} rmUSDC to ${options.receiver}`,
        transactions,
        warnings,
      },
      simulation: {
        ...simulation,
        preview:
          sharesToMint === null
            ? null
            : {
                sharesToMint: formatShares(sharesToMint),
                sharesRaw: sharesToMint.toString(),
              },
      },
    },
    { pretty: flags.pretty ?? false },
  );
}
