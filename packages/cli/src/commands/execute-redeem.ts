import { encodeFunctionData, type Address } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { buildBasketSellLeg } from '../lib/basket/leg-builders.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseShares } from '../lib/format.js';
import { resolveWallet, resolvePassphrase } from '../lib/wallet.js';
import { signAndSendSequence, resolveBroadcastRpcUrl } from '../lib/execute.js';
import { checkGasBudget } from '../lib/gas.js';
import type { UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface ExecuteRedeemOptions {
  shares: string; // "max", a decimal, or "0" to skip the vault leg
  wallet?: string | undefined;
  passphrase?: string | undefined;
  storagePath?: string | undefined;
  receiver?: Address | undefined;
  // Basket-sell controls
  sellAll?: boolean;
  sellPercent?: number;
  sellTokens?: string[];
  sellAmounts?: string[];
  slippageBps?: number;
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
  } else if (options.shares === '0') {
    sharesRaw = 0n;
  } else {
    sharesRaw = parseShares(options.shares);
  }

  const wantsBasketSell =
    options.sellAll === true ||
    options.sellPercent !== undefined ||
    (options.sellTokens && options.sellTokens.length > 0);

  if (sharesRaw === 0n && !wantsBasketSell) {
    throw new Error('Nothing to do — pass --shares N or a basket-sell flag.');
  }

  let grossAssets = 0n;
  let netAssets = 0n;
  if (sharesRaw > 0n) {
    const [g, n, paused] = (await Promise.all([
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
    if (paused) throw new Error('Vault is paused — redeem is temporarily disabled.');
    grossAssets = g;
    netAssets = n;
  }

  const transactions: UnsignedTx[] = [];

  if (sharesRaw > 0n) {
    transactions.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'redeem',
        args: [sharesRaw, receiver, wallet.address],
      }),
      value: '0',
      description: `vault.redeem(${sharesRaw.toString()}, ${receiver}, ${wallet.address})`,
    });
  }

  let basketDetails: Awaited<ReturnType<typeof buildBasketSellLeg>>['details'] = null;
  if (wantsBasketSell) {
    const sellArgs: Parameters<typeof buildBasketSellLeg>[1] = {
      user: wallet.address,
      recipient: receiver,
    };
    if (options.sellAll !== undefined) sellArgs.sellAll = options.sellAll;
    if (options.sellPercent !== undefined) sellArgs.sellPercent = options.sellPercent;
    if (options.sellTokens) sellArgs.sellTokens = options.sellTokens;
    if (options.sellAmounts) sellArgs.sellAmountsDecimal = options.sellAmounts;
    if (options.slippageBps !== undefined) sellArgs.slippageBps = options.slippageBps;
    const sellLeg = await buildBasketSellLeg(client, sellArgs);
    transactions.push(...sellLeg.transactions);
    basketDetails = sellLeg.details;
  }

  if (transactions.length === 0) {
    throw new Error('Selected basket-sell flags matched zero balances. Nothing to broadcast.');
  }

  const preflightGas =
    (sharesRaw > 0n ? 1_800_000n : 0n) + (basketDetails ? 1_500_000n : 0n);
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

  const summary =
    sharesRaw > 0n && basketDetails
      ? `Redeemed ${formatShares(sharesRaw)} rmUSDC -> ${formatUsdc(netAssets)} USDC + sold ${basketDetails.sells.length} basket token(s) via OWS wallet "${wallet.name}"`
      : sharesRaw > 0n
        ? `Redeemed ${formatShares(sharesRaw)} rmUSDC -> ${formatUsdc(netAssets)} USDC via OWS wallet "${wallet.name}"`
        : `Sold ${basketDetails!.sells.length} basket token(s) via OWS wallet "${wallet.name}"`;

  emitJson(
    {
      operation: {
        type: 'redeem',
        summary,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview:
        sharesRaw > 0n
          ? {
              sharesRedeemed: formatShares(sharesRaw),
              grossUsdc: formatUsdc(grossAssets),
              feeUsdc: formatUsdc(fee),
              netUsdc: formatUsdc(netAssets),
            }
          : null,
      ...(basketDetails ? { basket: basketDetails } : {}),
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
