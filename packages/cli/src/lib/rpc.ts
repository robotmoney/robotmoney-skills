import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { SupportedChain } from './addresses.js';

const PUBLIC_FALLBACK = 'https://base.llamarpc.com';

export interface RpcOptions {
  chain: SupportedChain;
  rpcUrl?: string | undefined;
}

export function resolveRpcUrl(opts: RpcOptions): { url: string; source: 'flag' | 'env' | 'fallback' } {
  if (opts.rpcUrl) return { url: opts.rpcUrl, source: 'flag' };
  const envUrl = process.env.RPC_URL;
  if (envUrl && envUrl.length > 0) return { url: envUrl, source: 'env' };
  return { url: PUBLIC_FALLBACK, source: 'fallback' };
}

export function createRpcClient(opts: RpcOptions): { client: PublicClient; rpcUrl: string } {
  const { url, source } = resolveRpcUrl(opts);
  if (source === 'fallback') {
    process.stderr.write(
      `warning: no --rpc-url flag or RPC_URL env var set. Falling back to ${PUBLIC_FALLBACK}. ` +
        `Configure a dedicated RPC (Alchemy, QuickNode, etc.) for anything beyond occasional calls.\n`,
    );
  }
  const client = createPublicClient({
    chain: base,
    transport: http(url, { timeout: 15_000 }),
  }) as PublicClient;
  return { client, rpcUrl: url };
}
