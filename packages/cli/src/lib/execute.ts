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
 * for all receipts. Nonces are assigned in-order from the current pending
 * nonce; we don't wait between broadcasts — Base accepts queued txs at
 * incrementing nonces as long as the sender has ETH for both.
 *
 * When an override is supplied for a given tx, it's used to estimate gas
 * (so a deposit that depends on an approval earlier in the sequence still
 * gets a correct gas limit).
 */
export async function signAndSendSequence(
  ctx: ExecuteContext,
  txs: UnsignedTx[],
  overridesByIndex: Record<number, StateOverride> = {},
): Promise<BroadcastedTx[]> {
  if (txs.length === 0) return [];

  const [startingNonce, fees] = await Promise.all([
    ctx.client.getTransactionCount({ address: ctx.user, blockTag: 'pending' }),
    ctx.client.estimateFeesPerGas(),
  ]);

  const chainId = base.id; // 8453
  const hashes: Hash[] = [];
  const descriptions = txs.map((t) => t.description);

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const stateOverride = overridesByIndex[i];

    // Estimate gas for this specific tx (with override if provided)
    let gas: bigint;
    try {
      gas = await ctx.client.estimateGas({
        account: ctx.user,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        ...(stateOverride ? { stateOverride } : {}),
      });
    } catch (err) {
      const info = extractRevert(err);
      throw new Error(
        `Pre-broadcast gas estimate failed for tx[${i}] "${tx.description}": ${info.message}. ` +
          'Aborting broadcast so no ETH is wasted.',
      );
    }
    // Pad 15% for safety against state changes between estimate and inclusion
    const paddedGas = (gas * 115n) / 100n;

    const serialized = serializeTransaction({
      type: 'eip1559',
      chainId,
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      nonce: Number(startingNonce) + i,
      gas: paddedGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    const { txHash } = await owsSignAndSend({
      walletName: ctx.walletName,
      serializedTx: serialized,
      passphrase: ctx.passphrase,
      rpcUrl: ctx.rpcUrl,
      storagePath: ctx.storagePath,
    });
    hashes.push(txHash);
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
    const base: BroadcastedTx = {
      hash,
      description: descriptions[i]!,
      status: receipt === null ? 'pending' : receipt.status === 'success' ? 'confirmed' : 'reverted',
    };
    if (receipt) {
      base.blockNumber = receipt.blockNumber.toString();
      base.gasUsed = receipt.gasUsed.toString();
    }
    return base;
  });
}
