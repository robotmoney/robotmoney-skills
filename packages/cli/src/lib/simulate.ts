import type { Address, Hex, PublicClient, StateOverride } from 'viem';
import { extractRevert } from './errors.js';

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string; // stringified wei
  description: string;
}

export interface SimulationFailure {
  index: number;
  description: string;
  revert: string | null;
  message: string;
  /** True when the revert is an expected artifact of simulating a dependent tx
   *  at latest-block state (e.g. deposit before approve). Agents should not
   *  surface these as real errors. */
  expected?: boolean;
}

export interface SimulationResult {
  allSucceeded: boolean;
  gasEstimate: string; // stringified total gas across transactions
  failures: SimulationFailure[];
  notes?: string[];
}

export interface SimulateOptions {
  /** Per-tx state override to apply when estimating gas for that tx.
   *  Useful for pre-applying an allowance when simulating a deposit that
   *  otherwise reverts at the allowance check. */
  overridesByIndex?: Record<number, StateOverride>;
}

/**
 * Estimate gas for each tx in sequence. When overridesByIndex[i] is provided,
 * the corresponding tx is estimated against that simulated state — used to
 * skip past the pre-approval revert that would otherwise inflate simulation
 * failures and collapse the estimate.
 */
export async function simulateSequence(
  client: PublicClient,
  txs: UnsignedTx[],
  from: Address,
  options: SimulateOptions = {},
): Promise<SimulationResult> {
  let totalGas = 0n;
  const failures: SimulationFailure[] = [];
  const notes: string[] = [];

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const stateOverride = options.overridesByIndex?.[i];
    try {
      const params = {
        account: from,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        ...(stateOverride ? { stateOverride } : {}),
      };
      const gas = await client.estimateGas(params);
      totalGas += gas;
    } catch (err) {
      const info = extractRevert(err);
      const failure: SimulationFailure = {
        index: i,
        description: tx.description,
        revert: info.name,
        message: info.message,
      };
      if (stateOverride) {
        notes.push(
          `tx[${i}] simulated with a state override; failure may reflect a real revert.`,
        );
      } else if (i > 0) {
        // Post-approval dependent tx failing without override — that's expected
        // because latest-block state doesn't include the pending approve.
        failure.expected = true;
        notes.push(
          `tx[${i}] ("${tx.description}") simulation failure is expected — it depends on tx[${i - 1}] being mined first.`,
        );
      }
      failures.push(failure);
    }
  }

  const realFailures = failures.filter((f) => !f.expected);

  return {
    allSucceeded: realFailures.length === 0,
    gasEstimate: totalGas.toString(),
    failures,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
