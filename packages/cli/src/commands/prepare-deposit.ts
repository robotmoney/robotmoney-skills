import type { Address, StateOverride } from 'viem';
import { encodeFunctionData, maxUint256 } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { simulateSequence, type UnsignedTx } from '../lib/simulate.js';
import { encodeAllowanceValue, usdcAllowanceSlot } from '../lib/storage-slots.js';
import { checkGasBudget } from '../lib/gas.js';
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
  if (shutdown) warnings.push('Vault is shut down \u2014 deposits are disabled.');
  if (paused) warnings.push('Vault is paused \u2014 deposits are temporarily disabled.');
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

  // previewDeposit is a pure read — works regardless of allowance.
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

  // Build a state override that pre-applies the approval in the simulated
  // state, so eth_estimateGas on the deposit tx reflects the true cost
  // (routing across 3 adapters ~ 1.8M gas) rather than reverting at the
  // allowance check and reporting a tiny number.
  const overridesByIndex: Record<number, StateOverride> = {};
  if (needsApproval) {
    const depositIndex = transactions.length - 1;
    overridesByIndex[depositIndex] = [
      {
        address: addrs.usdc,
        stateDiff: [
          {
            slot: usdcAllowanceSlot(options.userAddress, addrs.vault),
            value: encodeAllowanceValue(maxUint256),
          },
        ],
      },
    ];
  }

  const simulation = await simulateSequence(client, transactions, options.userAddress, {
    overridesByIndex,
  });

  // ETH budget check after we have a gas estimate
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
        type: 'deposit',
        summary:
          sharesToMint === null
            ? `Deposit ${options.amount} USDC`
            : `Deposit ${options.amount} USDC \u2192 mint ~${formatShares(sharesToMint)} rmUSDC to ${options.receiver}`,
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
