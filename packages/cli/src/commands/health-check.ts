import { ADDRESSES, CHAIN_IDS } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson } from '../lib/format.js';
import type { GlobalFlags } from '../lib/args.js';

export async function healthCheck(flags: GlobalFlags): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];

  const t0 = Date.now();
  const [blockNumber, paused, shutdown] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'paused' }),
    client.readContract({ address: addrs.vault, abi: VAULT_ABI, functionName: 'shutdown' }),
  ]);
  const rpcLatencyMs = Date.now() - t0;

  emitJson(
    {
      ok: true,
      chain: flags.chain,
      chainId: CHAIN_IDS[flags.chain],
      blockNumber: blockNumber.toString(),
      rpcLatencyMs,
      vault: addrs.vault,
      paused,
      shutdown,
    },
    { pretty: flags.pretty ?? false },
  );
}
