import {
  serializeTransaction,
  type Address,
  type Hash,
  type PublicClient,
  type StateOverride,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { resolveRpcUrl } from './rpc.js';
import { owsSignAndSend } from './wallet.js';
import { extractRevert } from './errors.js';
import type { UnsignedTx } from './simulate.js';

export interface BroadcastedTx {
  hash: Hash;
  description: string;
  status: 'confirmed' | 'reverted' | 'pending';
  blockNumber?: string;
  gasUsed?: string;
}

export interface ExecuteContext {
  client: PublicClient;
  user: Address;
  walletName: string;
  passphrase: string | undefined;
  rpcUrl: string;
  storagePath?: string | undefined;
}

export interface SignAndSendOptions {
  /** Per-tx state override applied during pre-broadcast gas estimation. Useful
   *  for the canonical case "deposit at index N depends on approve at index
   *  N-1": pre-apply the allowance via stateDiff so the estimate succeeds. */
  overridesByIndex?: Record<number, StateOverride>;
  /** Per-tx fallback gas to use when estimation fails AND the tx depends on
   *  an earlier tx in this same sequence (i.e., index > 0). The simulator
   *  already marks these as `expected: true`; this is the broadcast-side
   *  equivalent — we trust the prior tx will land in nonce order and use a
   *  conservative ceiling rather than aborting mid-sequence. Only applied to
   *  dependent txs (i > 0); a real revert on tx[0] still aborts cleanly with
   *  zero ETH spent. */
  fallbackGasByIndex?: Record<number, bigint>;
}

export async function resolveBroadcastRpcUrl(flags: {
  chain: 'base';
  rpcUrl?: string | undefined;
}): Promise<string> {
  const resolved = resolveRpcUrl(flags);
  // OWS needs a concrete URL to broadcast against; when we're on the fallback
  // pool, pick the first entry. viem's fallback transport handles read-path
  // retries, but signAndSend wants a single URL.
  if (resolved.url) return resolved.url;
  return 'https://base.drpc.org';
}

/**
 * Sign and broadcast a sequence of unsigned transactions via OWS, then wait
 * for all receipts. Two-pass:
 *
 *  1. Estimate gas for every tx upfront. If an estimate fails for a dependent
 *     tx (i > 0) and the caller supplied a fallback in `fallbackGasByIndex`,
 *     use the fallback. Otherwise abort BEFORE broadcasting anything — so
 *     "no transactions were broadcast" is a truthful claim.
 *  2. Sign + broadcast each tx in nonce order. If a broadcast fails after
 *     earlier txs already landed, the error message lists the in-flight
 *     hashes so the caller can recover.
 */
export async function signAndSendSequence(
  ctx: ExecuteContext,
  txs: UnsignedTx[],
  options: SignAndSendOptions = {},
): Promise<BroadcastedTx[]> {
  if (txs.length === 0) return [];

  const overridesByIndex = options.overridesByIndex ?? {};
  const fallbackGasByIndex = options.fallbackGasByIndex ?? {};

  // ---------- Phase 1: estimate gas for every tx upfront ----------
  const gasLimits = new Array<bigint>(txs.length);
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const stateOverride = overridesByIndex[i];

    let estimated: bigint;
    try {
      estimated = await ctx.client.estimateGas({
        account: ctx.user,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        ...(stateOverride ? { stateOverride } : {}),
      });
    } catch (err) {
      const fallback = fallbackGasByIndex[i];
      if (fallback !== undefined && i > 0) {
        // Dependent tx — its prerequisites land earlier in this same sequence
        // so a latest-block estimate will revert. Use the caller's fallback.
        estimated = fallback;
      } else {
        const info = extractRevert(err);
        throw new Error(
          `Pre-broadcast gas estimate failed for tx[${i}] "${tx.description}": ${info.message}. ` +
            'No transactions were broadcast — no ETH was spent.',
        );
      }
    }
    // 15% pad against state changes between estimate and inclusion.
    gasLimits[i] = (estimated * 115n) / 100n;
  }

  // ---------- Phase 2: broadcast in nonce order ----------
  const [startingNonce, fees] = await Promise.all([
    ctx.client.getTransactionCount({ address: ctx.user, blockTag: 'pending' }),
    ctx.client.estimateFeesPerGas(),
  ]);

  const chainId = base.id; // 8453
  const hashes: Hash[] = [];
  const descriptions = txs.map((t) => t.description);

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const serialized = serializeTransaction({
      type: 'eip1559',
      chainId,
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      nonce: Number(startingNonce) + i,
      gas: gasLimits[i]!,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    try {
      const { txHash } = await owsSignAndSend({
        walletName: ctx.walletName,
        serializedTx: serialized,
        passphrase: ctx.passphrase,
        rpcUrl: ctx.rpcUrl,
        storagePath: ctx.storagePath,
      });
      hashes.push(txHash);
    } catch (err) {
      // Honest message: distinguish nothing-yet from partial-in-flight.
      const partial =
        hashes.length > 0
          ? ` ${hashes.length} earlier tx(s) already broadcast and may land: ${hashes.join(', ')}.`
          : ' No transactions were broadcast — no ETH was spent.';
      throw new Error(
        `Broadcast failed for tx[${i}] "${tx.description}": ${(err as Error).message}.${partial}`,
      );
    }
  }

  // Wait for all receipts in parallel — OK because they're sequential nonces
  // from the same sender; the node will order them correctly.
  const receipts = await Promise.all(
    hashes.map((hash) =>
      ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch((): null => null),
    ),
  );

  return hashes.map((hash, i) => {
    const receipt: TransactionReceipt | null = receipts[i] ?? null;
    const result: BroadcastedTx = {
      hash,
      description: descriptions[i]!,
      status: receipt === null ? 'pending' : receipt.status === 'success' ? 'confirmed' : 'reverted',
    };
    if (receipt) {
      result.blockNumber = receipt.blockNumber.toString();
      result.gasUsed = receipt.gasUsed.toString();
    }
    return result;
  });
}
