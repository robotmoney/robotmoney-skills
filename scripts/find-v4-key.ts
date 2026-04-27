#!/usr/bin/env tsx
/**
 * Find the V4 PoolKey for one or more pool IDs by scanning the V4 PoolManager's
 * `Initialize` event. Free RPCs reject `fromBlock=0` for getLogs, so we chunk
 * backwards from the head in N-block windows.
 *
 * Run: pnpm exec tsx ../../scripts/find-v4-key.ts
 *
 * Edit POOL_IDS below to add/remove targets.
 */
import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { base } from 'viem/chains';

const V4_POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

// Pool IDs to resolve. Found via Dexscreener earlier.
const POOL_IDS: { symbol: string; id: Hex }[] = [
  { symbol: 'ROBOT', id: '0xcece56fd6eb8fcbc6c45af8181bfe71ea6057770630490cac36dbbc4aa27a4a6' },
  { symbol: 'JUNO', id: '0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e' },
];

// Chunk size in blocks. Coinbase's Base RPC tends to allow up to 10k per request.
const CHUNK_SIZE = 10_000n;
// Don't scan further back than this many blocks (covers ~12 weeks at 2s/block).
const MAX_LOOKBACK = 4_000_000n;

async function main() {
  // Use the official Base RPC — generally more permissive on log queries.
  const client = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org', { timeout: 20_000 }),
  });

  const head = await client.getBlockNumber();
  console.log(`Head block: ${head}`);

  for (const { symbol, id } of POOL_IDS) {
    console.log(`\n--- ${symbol} (${id}) ---`);
    const start = head;
    const stop = head > MAX_LOOKBACK ? head - MAX_LOOKBACK : 0n;
    let foundLog: Awaited<ReturnType<typeof client.getLogs>>[number] | null = null;

    for (let to = start; to > stop; to -= CHUNK_SIZE) {
      const from = to > CHUNK_SIZE ? to - CHUNK_SIZE + 1n : 0n;
      try {
        const logs = await client.getLogs({
          address: V4_POOL_MANAGER,
          event: INITIALIZE_EVENT,
          args: { id },
          fromBlock: from,
          toBlock: to,
        });
        if (logs.length > 0) {
          foundLog = logs[0]!;
          break;
        }
      } catch (err) {
        const msg = (err as Error).message.split('\n')[0];
        console.error(`  ! ${from}-${to}: ${msg}`);
        // back off briefly and continue
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (foundLog) {
      const a = foundLog.args;
      console.log(`  blockNumber: ${foundLog.blockNumber}`);
      console.log(`  txHash:      ${foundLog.transactionHash}`);
      console.log(`  currency0:   ${a.currency0}`);
      console.log(`  currency1:   ${a.currency1}`);
      console.log(`  fee:         ${a.fee} (0x${a.fee?.toString(16)})`);
      console.log(`  tickSpacing: ${a.tickSpacing}`);
      console.log(`  hooks:       ${a.hooks}`);
    } else {
      console.log(
        `  NOT FOUND in last ${MAX_LOOKBACK} blocks. Pool may be older — increase MAX_LOOKBACK.`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
