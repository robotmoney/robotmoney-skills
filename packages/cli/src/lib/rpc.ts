import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { SupportedChain } from './addresses.js';

// Curated pool of no-auth Base mainnet RPCs. Order roughly by observed latency
// and reliability as of the v0.1.2 release. viem's fallback() transport rotates
// through these automatically on 429/5xx/timeout so users don't need to know
// what an RPC URL is.
const BASE_RPC_POOL = [
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://base.meowrpc.com',
  'https://1rpc.io/base',
];

export interface RpcOptions {
  chain: SupportedChain;
  rpcUrl?: string | undefined;
}

export function resolveRpcUrl(
  opts: RpcOptions,
): { url: string | null; source: 'flag' | 'env' | 'pool' } {
  if (opts.rpcUrl) return { url: opts.rpcUrl, source: 'flag' };
  const envUrl = process.env.RPC_URL;
  if (envUrl && envUrl.length > 0) return { url: envUrl, source: 'env' };
  return { url: null, source: 'pool' };
}

export function createRpcClient(opts: RpcOptions): { client: PublicClient; rpcUrl: string } {
  const resolved = resolveRpcUrl(opts);

  if (resolved.url) {
    const client = createPublicClient({
      chain: base,
      transport: http(resolved.url, { timeout: 15_000 }),
    }) as PublicClient;
    return { client, rpcUrl: resolved.url };
  }

  // Fallback pool — viem handles retry/rotation on failure
  const transport = fallback(
    BASE_RPC_POOL.map((url) => http(url, { timeout: 10_000 })),
    { retryCount: 2 },
  );
  const client = createPublicClient({ chain: base, transport }) as PublicClient;
  return { client, rpcUrl: BASE_RPC_POOL[0]! };
}

export { BASE_RPC_POOL };
