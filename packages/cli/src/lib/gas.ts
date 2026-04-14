import type { Address, PublicClient } from 'viem';
import { formatEther } from 'viem';

export interface GasBudgetCheck {
  ethBalance: bigint;
  gasPriceWei: bigint;
  estimatedCostWei: bigint;
  warning: string | null;
  error: string | null;
}

/**
 * Compares the user's ETH balance against the projected cost of the prepared
 * transactions. Returns a warning when balance < 2x cost, and an error when
 * balance < 1x cost. Callers decide whether to surface the error (execute-*)
 * or downgrade it to a warning (prepare-*).
 */
export async function checkGasBudget(
  client: PublicClient,
  user: Address,
  estimatedGas: bigint,
): Promise<GasBudgetCheck> {
  const [ethBalance, gasPrice] = await Promise.all([
    client.getBalance({ address: user }),
    client.getGasPrice(),
  ]);

  // Pad gas price by 20% to account for in-flight increases between estimate and broadcast
  const paddedGasPrice = (gasPrice * 12n) / 10n;
  const estimatedCostWei = estimatedGas * paddedGasPrice;

  let warning: string | null = null;
  let error: string | null = null;

  if (ethBalance < estimatedCostWei) {
    error =
      `Wallet has ${formatEther(ethBalance)} ETH. Need at least ` +
      `${formatEther(estimatedCostWei)} ETH for gas. Send a small amount of ETH ` +
      `(roughly $0.01\u2013$0.05) to ${user} on Base before broadcasting.`;
  } else if (ethBalance < estimatedCostWei * 2n) {
    warning =
      `Wallet has ${formatEther(ethBalance)} ETH. Estimated gas cost is ` +
      `${formatEther(estimatedCostWei)} ETH. Balance covers this transaction but is low ` +
      `for follow-ups; consider topping up.`;
  }

  return {
    ethBalance,
    gasPriceWei: gasPrice,
    estimatedCostWei,
    warning,
    error,
  };
}
