import type { Address, Hex, PublicClient } from 'viem';
import { extractRevert } from './errors.js';

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string; // stringified wei
  description: string;
}

export interface SimulationResult {
  allSucceeded: boolean;
  gasEstimate: string; // stringified total gas across transactions
  failures: Array<{
    index: number;
    description: string;
    revert: string | null;
    message: string;
  }>;
}

/**
 * Sequentially simulate each tx via eth_call + estimateGas.
 * Note: the vault is single-tx per write path, and the approve+deposit pair
 * is linearly dependent (eth_call runs against latest block, so the approval
 * state isn't applied when simulating the deposit). We still estimate gas on
 * each call individually and short-circuit on the first failure so the caller
 * sees the actual revert name.
 */
export async function simulateSequence(
  client: PublicClient,
  txs: UnsignedTx[],
  from: Address,
): Promise<SimulationResult> {
  let totalGas = 0n;
  const failures: SimulationResult['failures'] = [];

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    try {
      const gas = await client.estimateGas({
        account: from,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
      });
      totalGas += gas;
    } catch (err) {
      const info = extractRevert(err);
      failures.push({
        index: i,
        description: tx.description,
        revert: info.name,
        message: info.message,
      });
      // Don't break — the second tx in a two-tx sequence (e.g. deposit after
      // approve) will almost always fail at latest block because the approval
      // hasn't been mined. Record the failure and continue so the caller can
      // see whether the deposit itself would revert for a different reason.
    }
  }

  return {
    allSucceeded: failures.length === 0,
    gasEstimate: totalGas.toString(),
    failures,
  };
}
