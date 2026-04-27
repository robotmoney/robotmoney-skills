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
import { emitJson, formatShares, formatUsdc, parseShares } from '../lib/format.js';
import { simulateSequence, type UnsignedTx } from '../lib/simulate.js';
import { checkGasBudget } from '../lib/gas.js';
import type { GlobalFlags } from '../lib/args.js';

export interface PrepareRedeemOptions {
  userAddress: Address;
  shares: string; // "max", a decimal, or "0" to skip the vault leg
  receiver: Address;
  // Basket-sell controls
  sellAll?: boolean;
  sellPercent?: number;
  sellTokens?: string[];
  sellAmounts?: string[]; // decimal strings, parallel to sellTokens
  slippageBps?: number;
}

export async function prepareRedeem(
  flags: GlobalFlags,
  options: PrepareRedeemOptions,
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // ---------- Vault leg ----------
  let sharesRaw: bigint;
  if (options.shares === 'max') {
    sharesRaw = (await client.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [options.userAddress],
    })) as bigint;
  } else if (options.shares === '0') {
    sharesRaw = 0n;
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

  // ---------- Basket sell leg ----------
  const wantsBasketSell =
    options.sellAll === true ||
    options.sellPercent !== undefined ||
    (options.sellTokens && options.sellTokens.length > 0);

  const transactions: UnsignedTx[] = [];
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

  // Vault redeem first — single tx, no approval needed (user owns the shares).
  if (sharesRaw > 0n) {
    transactions.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'redeem',
        args: [sharesRaw, options.receiver, options.userAddress],
      }),
      value: '0',
      description: `vault.redeem(${sharesRaw.toString()}, ${options.receiver}, ${options.userAddress})`,
    });
  }

  if (wantsBasketSell) {
    const holdings = await readBasketHoldings(client, options.userAddress);

    // Convert decimal sell-amounts to raw, paired with their symbols.
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
    if (inputs.length === 0) {
      // Selection asked for sells but every selected token had zero balance.
      // Fall through with no basket leg.
    } else {
      const quotes = await quoteBasketSell(client, inputs);

      // Per-token approval discovery: USDC -> Permit2 (the token here, not USDC),
      // then Permit2 -> UR. Read all in parallel.
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
  if (paused) warnings.push('Vault is paused — redeem is temporarily disabled.');
  if (sharesRaw === 0n && !wantsBasketSell) {
    warnings.push('Nothing to do — pass --shares N or a basket-sell flag.');
  }
  if (sharesRaw === 0n && wantsBasketSell && transactions.length === 0) {
    warnings.push('Selected basket-sell flags matched zero balances. No transactions emitted.');
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
    sharesRaw > 0n && basketDetails
      ? `Redeem ${formatShares(sharesRaw)} rmUSDC → ${formatUsdc(net)} USDC + sell ${basketDetails.sells.length} basket token(s) to ${options.receiver}`
      : sharesRaw > 0n
        ? `Redeem ${formatShares(sharesRaw)} rmUSDC → ${formatUsdc(net)} USDC to ${options.receiver} (after ${formatUsdc(fee)} exit fee)`
        : basketDetails
          ? `Sell ${basketDetails.sells.length} basket token(s) to ${options.receiver}`
          : 'No-op';

  emitJson(
    {
      operation: {
        type: 'redeem',
        summary,
        transactions,
        warnings,
      },
      simulation: {
        ...simulation,
        preview:
          sharesRaw > 0n
            ? {
                sharesRaw: sharesRaw.toString(),
                grossUsdc: formatUsdc(gross),
                feeUsdc: formatUsdc(fee),
                netUsdc: formatUsdc(net),
                netUsdcRaw: net.toString(),
              }
            : null,
      },
      ...(basketDetails ? { basket: basketDetails } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
