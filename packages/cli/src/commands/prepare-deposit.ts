import type { Address, StateOverride } from 'viem';
import { encodeFunctionData, maxUint256 } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { PERMIT2_ABI, USDC_ABI, VAULT_ABI } from '../lib/abi.js';
import {
  BASKET,
  BASKET_SPLIT_BPS,
  BPS_DENOMINATOR,
  DEFAULT_SLIPPAGE_BPS,
  PERMIT2,
  QUOTE_VALIDITY_MINUTES,
  UNIVERSAL_ROUTER,
  USDC as BASKET_USDC,
  VAULT_SPLIT_BPS,
} from '../lib/basket/constants.js';
import { encodeBasketBuy, buildErc20Approve, buildPermit2Approve } from '../lib/basket/encoder.js';
import { applySlippage, quoteBasketBuy } from '../lib/basket/quoter.js';
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
  // Basket-leg controls
  noBasket?: boolean;
  basketOnly?: boolean;
  slippageBps?: number;
}

export async function prepareDeposit(
  flags: GlobalFlags,
  options: PrepareDepositOptions,
): Promise<void> {
  if (options.noBasket && options.basketOnly) {
    throw new Error('--no-basket and --basket-only are mutually exclusive');
  }

  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const amountRaw = parseUsdc(options.amount);
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // 95% vault, 5% basket — unless one of the leg-skip flags is set.
  const basketAmount = options.noBasket
    ? 0n
    : options.basketOnly
      ? amountRaw
      : (amountRaw * BigInt(BASKET_SPLIT_BPS)) / BigInt(BPS_DENOMINATOR);
  const vaultAmount = amountRaw - basketAmount;

  const [
    currentAllowance,
    tvlCap,
    perDepositCap,
    totalAssets,
    paused,
    shutdown,
    usdcToPermit2,
    permit2ToUr,
  ] = (await Promise.all([
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
    client.readContract({
      address: addrs.usdc,
      abi: USDC_ABI,
      functionName: 'allowance',
      args: [options.userAddress, PERMIT2],
    }),
    client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [options.userAddress, BASKET_USDC, UNIVERSAL_ROUTER],
    }),
  ])) as [bigint, bigint, bigint, bigint, boolean, boolean, bigint, readonly [bigint, number, number]];

  const transactions: UnsignedTx[] = [];

  // ---------- Vault leg ----------
  if (vaultAmount > 0n) {
    const needsApproval = !options.skipApprove && currentAllowance < vaultAmount;
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
        args: [vaultAmount, options.receiver],
      }),
      value: '0',
      description: `vault.deposit(${vaultAmount.toString()}, ${options.receiver})`,
    });
  }

  // ---------- Basket leg ----------
  let basketDetails: {
    totalUsdc: string;
    perLegUsdc: string;
    slippageBps: number;
    validUntil: number;
    quotes: Array<{
      symbol: string;
      address: Address;
      amountOut: string;
      minAmountOut: string;
      decimals: number;
    }>;
  } | null = null;
  if (basketAmount > 0n) {
    const perLegUsdc = basketAmount / BigInt(BASKET.length);
    if (perLegUsdc === 0n) {
      throw new Error(
        `Basket per-leg amount rounds to zero (basket=${basketAmount} / ${BASKET.length}). Increase --amount or pass --no-basket.`,
      );
    }
    const quotes = await quoteBasketBuy(client, perLegUsdc);

    // USDC -> Permit2 approval (one-time-ish; we set it to max).
    if (usdcToPermit2 < basketAmount) {
      transactions.push(buildErc20Approve(addrs.usdc, PERMIT2, maxUint256));
    }

    // Permit2 -> UR approval. Permit2 stores (uint160 amount, uint48 expiration, uint48 nonce).
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const permit2Amount = permit2ToUr[0];
    const permit2Expiration = BigInt(permit2ToUr[1]);
    const needsPermit2Approval = permit2Amount < basketAmount || permit2Expiration < nowSec;
    if (needsPermit2Approval) {
      const maxU160 = (1n << 160n) - 1n;
      const expiration = nowSec + 365n * 24n * 3600n; // 1 year
      transactions.push(buildPermit2Approve(addrs.usdc, UNIVERSAL_ROUTER, maxU160, expiration));
    }

    const deadline = nowSec + BigInt(QUOTE_VALIDITY_MINUTES * 60);
    const { unsignedTx } = encodeBasketBuy({
      recipient: options.receiver,
      deadline,
      slippageBps,
      quotes,
      totalUsdc: basketAmount,
    });
    transactions.push(unsignedTx);

    basketDetails = {
      totalUsdc: formatUsdc(basketAmount),
      perLegUsdc: formatUsdc(perLegUsdc),
      slippageBps,
      validUntil: Number(deadline),
      quotes: quotes.map((q) => ({
        symbol: q.symbol,
        address: q.address,
        amountOut: q.amountOut.toString(),
        minAmountOut: applySlippage(q.amountOut, slippageBps).toString(),
        decimals: q.decimals,
      })),
    };
  }

  const warnings: string[] = [];
  if (vaultAmount > 0n) {
    if (shutdown) warnings.push('Vault is shut down \u2014 deposits are disabled.');
    if (paused) warnings.push('Vault is paused \u2014 deposits are temporarily disabled.');
    if (vaultAmount > perDepositCap) {
      warnings.push(
        `Vault leg ${formatUsdc(vaultAmount)} exceeds perDepositCap ${formatUsdc(perDepositCap)}.`,
      );
    }
    if (totalAssets + vaultAmount > tvlCap) {
      warnings.push(
        `Vault deposit would exceed TVL cap (${formatUsdc(tvlCap)}). Current TVL: ${formatUsdc(totalAssets)}.`,
      );
    }
  }

  let sharesToMint: bigint | null = null;
  if (vaultAmount > 0n) {
    try {
      sharesToMint = (await client.readContract({
        address: addrs.vault,
        abi: VAULT_ABI,
        functionName: 'previewDeposit',
        args: [vaultAmount],
      })) as bigint;
    } catch {
      sharesToMint = null;
    }
  }

  // Pre-apply the vault USDC approval in simulation so eth_estimateGas reflects
  // the true cost of vault.deposit (~1.8M gas) rather than reverting at the
  // allowance check.
  const overridesByIndex: Record<number, StateOverride> = {};
  if (vaultAmount > 0n) {
    const vaultApprovalNeeded = !options.skipApprove && currentAllowance < vaultAmount;
    if (vaultApprovalNeeded) {
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
                slot: usdcAllowanceSlot(options.userAddress, addrs.vault),
                value: encodeAllowanceValue(maxUint256),
              },
            ],
          },
        ];
      }
    }
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

  const summary =
    vaultAmount > 0n && basketAmount > 0n
      ? `Deposit ${options.amount} USDC: ${formatUsdc(vaultAmount)} to vault${
          sharesToMint !== null ? ` (~${formatShares(sharesToMint)} rmUSDC)` : ''
        } + ${formatUsdc(basketAmount)} across ${BASKET.length} basket tokens, all to ${options.receiver}`
      : vaultAmount > 0n
        ? `Deposit ${options.amount} USDC${
            sharesToMint !== null ? ` \u2192 mint ~${formatShares(sharesToMint)} rmUSDC` : ''
          } to ${options.receiver}`
        : `Buy ${formatUsdc(basketAmount)} of basket (${BASKET.length} tokens) for ${options.receiver}`;

  emitJson(
    {
      operation: {
        type: 'deposit',
        summary,
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
      ...(basketDetails ? { basket: basketDetails } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
