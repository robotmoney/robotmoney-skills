import { encodeFunctionData, maxUint256, type Address, type StateOverride } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import {
  BASKET_SPLIT_BPS,
  BPS_DENOMINATOR,
  USDC as BASKET_USDC,
} from '../lib/basket/constants.js';
import { buildBasketBuyLeg } from '../lib/basket/leg-builders.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
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
  // Basket-leg controls
  noBasket?: boolean;
  basketOnly?: boolean;
  slippageBps?: number;
}

export async function executeDeposit(
  flags: GlobalFlags,
  options: ExecuteDepositOptions,
): Promise<void> {
  if (options.noBasket && options.basketOnly) {
    throw new Error('--no-basket and --basket-only are mutually exclusive');
  }

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

  const basketAmount = options.noBasket
    ? 0n
    : options.basketOnly
      ? amountRaw
      : (amountRaw * BigInt(BASKET_SPLIT_BPS)) / BigInt(BPS_DENOMINATOR);
  const vaultAmount = amountRaw - basketAmount;

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

  if (vaultAmount > 0n) {
    if (shutdown) throw new Error('Vault is shut down \u2014 deposits are disabled.');
    if (paused) throw new Error('Vault is paused \u2014 deposits are temporarily disabled.');
    if (vaultAmount > perDepositCap)
      throw new Error(`Vault leg exceeds perDepositCap (${perDepositCap.toString()} raw).`);
    if (totalAssets + vaultAmount > tvlCap) throw new Error('Vault deposit would exceed TVL cap.');
  }

  const transactions: UnsignedTx[] = [];
  const needsApproval = vaultAmount > 0n && currentAllowance < vaultAmount;

  // Vault leg
  if (vaultAmount > 0n) {
    if (needsApproval) {
      transactions.push({
        to: addrs.usdc,
        data: encodeFunctionData({
          abi: USDC_ABI,
          functionName: 'approve',
          args: [addrs.vault, vaultAmount],
        }),
        value: '0',
        description: `USDC.approve(vault, ${vaultAmount.toString()})`,
      });
    }
    transactions.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [vaultAmount, receiver],
      }),
      value: '0',
      description: `vault.deposit(${vaultAmount.toString()}, ${receiver})`,
    });
  }

  // Basket leg
  let basketDetails: Awaited<ReturnType<typeof buildBasketBuyLeg>>['details'] | null = null;
  if (basketAmount > 0n) {
    const buyLeg = await buildBasketBuyLeg(client, {
      usdc: BASKET_USDC,
      user: wallet.address,
      recipient: receiver,
      basketAmountRaw: basketAmount,
      ...(options.slippageBps !== undefined ? { slippageBps: options.slippageBps } : {}),
    });
    transactions.push(...buyLeg.transactions);
    basketDetails = buyLeg.details;
  }

  // Pre-apply the vault approval for the deposit's gas estimate.
  const overridesByIndex: Record<number, StateOverride> = {};
  if (needsApproval) {
    const depositIndex = transactions.findIndex(
      (tx) =>
        tx.to.toLowerCase() === addrs.vault.toLowerCase() &&
        tx.description?.startsWith('vault.deposit'),
    );
    if (depositIndex >= 0) {
      overridesByIndex[depositIndex] = [
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
  }

  // Pre-flight gas budget: vault leg (~1.9M) + basket leg (~1M for UR.execute + approvals).
  const preflightGas = (vaultAmount > 0n ? 1_900_000n : 0n) + (basketAmount > 0n ? 1_200_000n : 0n);
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
  if (vaultAmount > 0n) {
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
  }

  const summary =
    vaultAmount > 0n && basketAmount > 0n
      ? `Deposited ${options.amount} USDC: ${formatUsdc(vaultAmount)} to vault + ${formatUsdc(basketAmount)} across basket via OWS wallet "${wallet.name}"`
      : vaultAmount > 0n
        ? `Deposited ${options.amount} USDC to vault via OWS wallet "${wallet.name}"`
        : `Bought basket (${formatUsdc(basketAmount)}) via OWS wallet "${wallet.name}"`;

  emitJson(
    {
      operation: {
        type: 'deposit',
        summary,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview: sharesMinted !== null ? { receiverShareBalance: sharesMinted } : null,
      ...(basketDetails ? { basket: basketDetails } : {}),
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
