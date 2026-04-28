import { encodeFunctionData, type Address } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { buildBasketSellLeg } from '../lib/basket/leg-builders.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { resolveWallet, resolvePassphrase } from '../lib/wallet.js';
import { signAndSendSequence, resolveBroadcastRpcUrl } from '../lib/execute.js';
import { checkGasBudget } from '../lib/gas.js';
import type { UnsignedTx } from '../lib/simulate.js';
import type { GlobalFlags } from '../lib/args.js';

export interface ExecuteWithdrawOptions {
  amount: string; // net USDC target; "0" skips vault leg.
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

  const wantsBasketSell =
    options.sellAll === true ||
    options.sellPercent !== undefined ||
    (options.sellTokens && options.sellTokens.length > 0);

  if (netUsdc === 0n && !wantsBasketSell) {
    throw new Error('Nothing to do — pass --amount N or a basket-sell flag.');
  }

  let sharesNeeded = 0n;
  let grossUsdc = 0n;
  if (netUsdc > 0n) {
    const [sN, g, paused] = (await Promise.all([
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
    if (paused) throw new Error('Vault is paused — withdraw is temporarily disabled.');
    sharesNeeded = sN;
    grossUsdc = g;
  }

  const transactions: UnsignedTx[] = [];
  if (netUsdc > 0n) {
    transactions.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [netUsdc, receiver, wallet.address],
      }),
      value: '0',
      description: `vault.withdraw(${netUsdc.toString()}, ${receiver}, ${wallet.address})`,
    });
  }

  let basketDetails: Awaited<ReturnType<typeof buildBasketSellLeg>>['details'] = null;
  const fallbackGasByIndex: Record<number, bigint> = {};
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
    const offset = transactions.length;
    for (const [localIdx, gas] of Object.entries(sellLeg.fallbackGasByIndex)) {
      fallbackGasByIndex[offset + Number(localIdx)] = gas;
    }
    transactions.push(...sellLeg.transactions);
    basketDetails = sellLeg.details;
  }

  if (transactions.length === 0) {
    throw new Error('Selected basket-sell flags matched zero balances. Nothing to broadcast.');
  }

  const preflightGas = (netUsdc > 0n ? 1_800_000n : 0n) + (basketDetails ? 1_500_000n : 0n);
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
    { fallbackGasByIndex },
  );

  const fee = grossUsdc >= netUsdc ? grossUsdc - netUsdc : 0n;

  const summary =
    netUsdc > 0n && basketDetails
      ? `Withdrew ${formatUsdc(netUsdc)} USDC + sold ${basketDetails.sells.length} basket token(s) via OWS wallet "${wallet.name}"`
      : netUsdc > 0n
        ? `Withdrew ${formatUsdc(netUsdc)} USDC (burn ~${formatShares(sharesNeeded)} rmUSDC) via OWS wallet "${wallet.name}"`
        : `Sold ${basketDetails!.sells.length} basket token(s) via OWS wallet "${wallet.name}"`;

  emitJson(
    {
      operation: {
        type: 'withdraw',
        summary,
        wallet: { name: wallet.name, address: wallet.address },
        receiver,
      },
      transactions: results,
      preview:
        netUsdc > 0n
          ? {
              sharesBurned: formatShares(sharesNeeded),
              grossUsdc: formatUsdc(grossUsdc),
              feeUsdc: formatUsdc(fee),
              netUsdc: formatUsdc(netUsdc),
            }
          : null,
      ...(basketDetails ? { basket: basketDetails } : {}),
      ...(gasCheck.warning ? { warnings: [gasCheck.warning] } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
