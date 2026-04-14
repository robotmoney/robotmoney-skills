import { encodeFunctionData, maxUint256, type Address, type StateOverride } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, parseUsdc } from '../lib/format.js';
import { resolveWallet, resolvePassphrase } from '../lib/wallet.js';
import { signAndSendSequence, resolveBroadcastRpcUrl } from '../lib/execute.js';
import { usdcAllowanceSlot, encodeAllowanceValue } from '../lib/storage-slots.js';
import { checkGasBudget } from '../lib/gas.js';
import type { UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface ExecuteDepositOptions {
  amount: string;
  wallet?: string | undefined;
  passphrase?: string | undefined;
  storagePath?: string | undefined;
  receiver?: Address | undefined;
}

export async function executeDeposit(
  flags: GlobalFlags,
  options: ExecuteDepositOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const amountRaw = parseUsdc(options.amount);

  const wallet = await resolveWallet({
    walletName: options.wallet,
    storagePath: options.storagePath,
  });
  const receiver = options.receiver ?? wallet.address;
  const passphrase = await resolvePassphrase({ passphraseFlag: options.passphrase });
  const rpcUrl = await resolveBroadcastRpcUrl(flags);

  const [currentAllowance, tvlCap, perDepositCap, totalAssets, paused, shutdown] = (await Promise.all([
    client.readContract({
      address: addrs.usdc,
      abi: USDC_ABI,
      functionName: 'allowance',
      args: [wallet.address, addrs.vault],
    }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'tvlCap' }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'perDepositCap' }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'totalAssets' }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'shutdown' }),
  ])) as [bigint, bigint, bigint, bigint, boolean, boolean];

  if (shutdown) throw new Error('Vault is shut down \u2014 deposits are disabled.');
  if (paused) throw new Error('Vault is paused \u2014 deposits are temporarily disabled.');
  if (amountRaw > perDepositCap)
    throw new Error(`Amount exceeds perDepositCap (${perDepositCap.toString()} raw).`);
  if (totalAssets + amountRaw > tvlCap) throw new Error('Deposit would exceed TVL cap.');

  const transactions: UnsignedTx[] = [];
  const needsApproval = currentAllowance < amountRaw;

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
      args: [amountRaw, receiver],
    }),
    value: '0',
    description: `vault.deposit(${amountRaw.toString()}, ${receiver})`,
  });

  // For gas estimation on the deposit, pre-apply the approval in simulated state
  const overridesByIndex: Record<number, StateOverride> = {};
  if (needsApproval) {
    overridesByIndex[transactions.length - 1] = [
      {
        address: addrs.usdc,
        stateDiff: [
          {
            slot: usdcAllowanceSlot(wallet.address, addrs.vault),
            value: encodeAllowanceValue(maxUint256),
          },
        ],
      },
    ];
  }

  // Verify ETH budget before kicking off any signed tx
  // Rough total-gas estimate upfront (approve ~60k + deposit ~1.8M); conservative
  const preflightGas = needsApproval ? 1_900_000n : 1_800_000n;
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
    overridesByIndex,
  );

  // Post-confirmation: read actual new balance
  let sharesMinted: string | null = null;
  try {
    const balance = (await client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [receiver],
    })) as bigint;
    sharesMinted = formatShares(balance);
  } catch {
    sharesMinted = null;
  }

  emitJson(
    {
      operation: {
        type: 'deposit',
        summary: `Deposited ${options.amount} USDC via OWS wallet "${wallet.name}"`,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview: sharesMinted !== null ? { receiverShareBalance: sharesMinted } : null,
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
