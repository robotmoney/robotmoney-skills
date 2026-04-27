import type { Address } from 'viem';
import { encodeFunctionData, maxUint256, parseUnits } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { PERMIT2_ABI, USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import {
  DEFAULT_SLIPPAGE_BPS,
  PERMIT2,
  QUOTE_VALIDITY_MINUTES,
  UNIVERSAL_ROUTER,
} from '../lib/basket/constants.js';
import {
  buildErc20Approve,
  buildPermit2Approve,
  encodeBasketSell,
} from '../lib/basket/encoder.js';
import {
  readBasketHoldings,
  selectSells,
  type SellSelectionOptions,
} from '../lib/basket/holdings.js';
import { applySlippage, quoteBasketSell } from '../lib/basket/quoter.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc, parseUsdc } from '../lib/format.js';
import { simulateSequence, type UnsignedTx } from '../lib/simulate.js';
import { checkGasBudget } from '../lib/gas.js';
import type { GlobalFlags } from '../lib/args.js';

export interface PrepareWithdrawOptions {
  userAddress: Address;
  amount: string; // decimal USDC net; "0" skips the vault leg.
  receiver: Address;
  // Basket-sell controls
  sellAll?: boolean;
  sellPercent?: number;
  sellTokens?: string[];
  sellAmounts?: string[];
  slippageBps?: number;
}

export async function prepareWithdraw(
  flags: GlobalFlags,
  options: PrepareWithdrawOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const netUsdc = parseUsdc(options.amount);
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  let sharesNeeded = 0n;
  let grossUsdc = 0n;
  let paused = false;

  if (netUsdc > 0n) {
    const [sN, g, p] = (await Promise.all([
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
    sharesNeeded = sN;
    grossUsdc = g;
    paused = p;
  }

  const fee = grossUsdc >= netUsdc ? grossUsdc - netUsdc : 0n;

  const transactions: UnsignedTx[] = [];
  if (netUsdc > 0n) {
    transactions.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [netUsdc, options.receiver, options.userAddress],
      }),
      value: '0',
      description: `vault.withdraw(${netUsdc.toString()}, ${options.receiver}, ${options.userAddress})`,
    });
  }

  // ---------- Basket sell leg ----------
  const wantsBasketSell =
    options.sellAll === true ||
    options.sellPercent !== undefined ||
    (options.sellTokens && options.sellTokens.length > 0);

  let basketDetails: {
    slippageBps: number;
    validUntil: number;
    sells: Array<{
      symbol: string;
      address: Address;
      amountIn: string;
      usdcOut: string;
      minUsdcOut: string;
    }>;
  } | null = null;

  if (wantsBasketSell) {
    const holdings = await readBasketHoldings(client, options.userAddress);

    const opts: SellSelectionOptions = {};
    if (options.sellAll !== undefined) opts.sellAll = options.sellAll;
    if (options.sellPercent !== undefined) opts.sellPercent = options.sellPercent;
    if (options.sellTokens) opts.sellTokens = options.sellTokens;
    if (options.sellAmounts && options.sellTokens) {
      opts.sellAmountsRaw = options.sellAmounts.map((amt, i) => {
        const sym = options.sellTokens![i]!;
        const h = holdings.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
        if (!h) throw new Error(`Unknown basket symbol: ${sym}`);
        return parseUnits(amt, h.decimals);
      });
    }

    const { inputs } = selectSells(holdings, opts);
    if (inputs.length > 0) {
      const quotes = await quoteBasketSell(client, inputs);

      const allowanceReads = await Promise.all(
        inputs.flatMap(({ token }) => [
          client.readContract({
            address: token.address,
            abi: USDC_ABI,
            functionName: 'allowance',
            args: [options.userAddress, PERMIT2],
          }),
          client.readContract({
            address: PERMIT2,
            abi: PERMIT2_ABI,
            functionName: 'allowance',
            args: [options.userAddress, token.address, UNIVERSAL_ROUTER],
          }),
        ]),
      );

      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const maxU160 = (1n << 160n) - 1n;
      const expiration = nowSec + 365n * 24n * 3600n;

      for (let i = 0; i < inputs.length; i++) {
        const { token, amountIn } = inputs[i]!;
        const tokenToPermit2 = allowanceReads[i * 2] as bigint;
        const permit2ToUr = allowanceReads[i * 2 + 1] as readonly [bigint, number, number];

        if (tokenToPermit2 < amountIn) {
          transactions.push(buildErc20Approve(token.address, PERMIT2, maxUint256));
        }
        if (permit2ToUr[0] < amountIn || BigInt(permit2ToUr[1]) < nowSec) {
          transactions.push(
            buildPermit2Approve(token.address, UNIVERSAL_ROUTER, maxU160, expiration),
          );
        }
      }

      const deadline = nowSec + BigInt(QUOTE_VALIDITY_MINUTES * 60);
      const sellInputs = inputs.map((input, i) => ({
        token: input.token,
        amountIn: input.amountIn,
        minUsdcOut: applySlippage(quotes[i]!.amountOut, slippageBps),
      }));
      transactions.push(encodeBasketSell(sellInputs, options.receiver, deadline));

      basketDetails = {
        slippageBps,
        validUntil: Number(deadline),
        sells: inputs.map((input, i) => ({
          symbol: input.token.symbol,
          address: input.token.address,
          amountIn: input.amountIn.toString(),
          usdcOut: quotes[i]!.amountOut.toString(),
          minUsdcOut: applySlippage(quotes[i]!.amountOut, slippageBps).toString(),
        })),
      };
    }
  }

  const warnings: string[] = [];
  if (netUsdc > 0n && paused) warnings.push('Vault is paused — withdraw is temporarily disabled.');
  if (transactions.length === 0) {
    warnings.push('Nothing to do — pass --amount N or a basket-sell flag.');
  }

  const simulation =
    transactions.length > 0
      ? await simulateSequence(client, transactions, options.userAddress)
      : { allSucceeded: true, gasEstimate: '0', failures: [], notes: [] };

  if (transactions.length > 0) {
    const gasCheck = await checkGasBudget(
      client,
      options.userAddress,
      BigInt(simulation.gasEstimate || '0'),
    );
    if (gasCheck.error) warnings.push(gasCheck.error);
    else if (gasCheck.warning) warnings.push(gasCheck.warning);
  }

  const summary =
    netUsdc > 0n && basketDetails
      ? `Withdraw ${formatUsdc(netUsdc)} USDC (burn ~${formatShares(sharesNeeded)} rmUSDC) + sell ${basketDetails.sells.length} basket token(s) to ${options.receiver}`
      : netUsdc > 0n
        ? `Withdraw ${formatUsdc(netUsdc)} USDC net (burn ~${formatShares(sharesNeeded)} rmUSDC, ${formatUsdc(fee)} exit fee) → ${options.receiver}`
        : basketDetails
          ? `Sell ${basketDetails.sells.length} basket token(s) to ${options.receiver}`
          : 'No-op';

  emitJson(
    {
      operation: {
        type: 'withdraw',
        summary,
        transactions,
        warnings,
      },
      simulation: {
        ...simulation,
        preview:
          netUsdc > 0n
            ? {
                sharesRequired: formatShares(sharesNeeded),
                sharesRequiredRaw: sharesNeeded.toString(),
                grossUsdc: formatUsdc(grossUsdc),
                feeUsdc: formatUsdc(fee),
                netUsdc: formatUsdc(netUsdc),
              }
            : null,
      },
      ...(basketDetails ? { basket: basketDetails } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
