import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { captureStdout, captureStderr, makeMockClient, type MockReadHandler } from './helpers.js';

vi.mock('../src/lib/rpc.js', () => ({
  createRpcClient: vi.fn(),
  resolveRpcUrl: vi.fn(() => ({ url: 'http://mock', source: 'flag' })),
}));

vi.mock('../src/lib/morpho-apy.js', () => ({
  fetchMorphoNetApy: vi.fn(async () => ({ netApy: 0.0505, source: 'primary' })),
}));

import { createRpcClient } from '../src/lib/rpc.js';
import { healthCheck } from '../src/commands/health-check.js';
import { getVault } from '../src/commands/get-vault.js';
import { getBalance } from '../src/commands/get-balance.js';
import { getApy } from '../src/commands/get-apy.js';
import { ADDRESSES } from '../src/lib/addresses.js';

const addrs = ADDRESSES.base;

function mockClientWith(handler: MockReadHandler) {
  const client = makeMockClient(handler);
  (createRpcClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    client,
    rpcUrl: 'http://mock',
  });
  return client;
}

function parseLastJson(chunks: string[]): unknown {
  const last = chunks.filter((c) => c.trim().startsWith('{')).pop();
  if (!last) throw new Error(`no JSON on stdout. stdout: ${JSON.stringify(chunks)}`);
  return JSON.parse(last);
}

let stdoutCap: ReturnType<typeof captureStdout>;
let stderrCap: ReturnType<typeof captureStderr>;
beforeEach(() => {
  stdoutCap = captureStdout();
  stderrCap = captureStderr();
});
afterEach(() => {
  stdoutCap.restore();
  stderrCap.restore();
  vi.clearAllMocks();
});

describe('health-check', () => {
  test('emits ok=true with vault state', async () => {
    mockClientWith(({ functionName }) => {
      if (functionName === 'paused') return false;
      if (functionName === 'shutdown') return false;
      throw new Error(`unexpected call: ${functionName}`);
    });

    await healthCheck({ chain: 'base' });

    const json = parseLastJson(stdoutCap.chunks) as {
      ok: boolean;
      chainId: number;
      vault: string;
      paused: boolean;
      shutdown: boolean;
    };
    expect(json.ok).toBe(true);
    expect(json.chainId).toBe(8453);
    expect(json.vault.toLowerCase()).toBe(addrs.vault.toLowerCase());
    expect(json.paused).toBe(false);
    expect(json.shutdown).toBe(false);
  });
});

describe('get-vault', () => {
  test('returns full vault shape', async () => {
    mockClientWith(({ functionName, args }) => {
      switch (functionName) {
        case 'asset':
          return addrs.usdc;
        case 'totalAssets':
          return 123_000_000n;
        case 'totalSupply':
          return 120_000_000n;
        case 'paused':
          return false;
        case 'shutdown':
          return false;
        case 'tvlCap':
          return 500_000_000n;
        case 'perDepositCap':
          return 100_000_000n;
        case 'exitFeeBps':
          return 25n;
        case 'feeRecipient':
          return '0xf9572bDF7dA594a8A92CC33142f0F053eB6ff03F';
        case 'adapterCount':
          return 3n;
        case 'symbol':
          return 'USDC';
        case 'decimals':
          return 6;
        case 'getAdapterInfo': {
          const i = Number((args ?? [0n])[0] as bigint);
          const adapters = [addrs.morphoAdapter, addrs.aaveAdapter, addrs.compoundAdapter];
          return [adapters[i], 5000, true, 41_000_000n, 3333n];
        }
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await getVault({ chain: 'base' }, { verbose: true });

    const json = parseLastJson(stdoutCap.chunks) as {
      exitFeeBps: number;
      tvlCap: string;
      activeAdapterCount: number;
      adapters: { length: number }[];
      shareToken: { symbol: string };
    };
    expect(json.exitFeeBps).toBe(25);
    expect(json.tvlCap).toBe('500');
    expect(json.activeAdapterCount).toBe(3);
    expect(json.adapters).toHaveLength(3);
    expect(json.shareToken.symbol).toBe('rmUSDC');
  });
});

describe('get-balance', () => {
  test('returns shares + gross + net values', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'balanceOf':
          return 100_000_000n;
        case 'convertToAssets':
          return 102_340_000n;
        case 'previewRedeem':
          return 102_083_150n;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await getBalance(
      { chain: 'base' },
      '0x0000000000000000000000000000000000000001',
    );

    const json = parseLastJson(stdoutCap.chunks) as {
      shares: string;
      grossValueUsdc: string;
      netValueUsdc: string;
      exitFeeUsdc: string;
    };
    expect(json.shares).toBe('100');
    expect(json.grossValueUsdc).toBe('102.34');
    expect(json.netValueUsdc).toBe('102.08315');
    expect(json.exitFeeUsdc).toBe('0.25685');
  });

  test('handles zero balance without RPC calls for preview', async () => {
    mockClientWith(({ functionName }) => {
      if (functionName === 'balanceOf') return 0n;
      throw new Error(`should not call: ${functionName}`);
    });

    await getBalance(
      { chain: 'base' },
      '0x0000000000000000000000000000000000000002',
    );
    const json = parseLastJson(stdoutCap.chunks) as { shares: string; netValueUsdc: string };
    expect(json.shares).toBe('0');
    expect(json.netValueUsdc).toBe('0');
  });
});

describe('get-apy', () => {
  test('blends Morpho + Aave + Compound', async () => {
    mockClientWith(({ functionName, args, address }) => {
      if (address?.toLowerCase() === addrs.vault.toLowerCase()) {
        if (functionName === 'adapterCount') return 3n;
        if (functionName === 'getAdapterInfo') {
          const i = Number((args ?? [0n])[0] as bigint);
          const adapters = [addrs.morphoAdapter, addrs.aaveAdapter, addrs.compoundAdapter];
          return [adapters[i], 5000, true, 0n, 3333n];
        }
      }
      if (address?.toLowerCase() === addrs.aavePool.toLowerCase()) {
        if (functionName === 'getReserveData') {
          // 2.64% APY → rate 0.0264 → ray = 0.0264 * 1e27 = 2.64e25
          return { currentLiquidityRate: 26_400_000_000_000_000_000_000_000n };
        }
      }
      if (address?.toLowerCase() === addrs.compoundComet.toLowerCase()) {
        if (functionName === 'getUtilization') return 500_000_000_000_000_000n;
        if (functionName === 'getSupplyRate') {
          // 3.13% APY → per-second rate = 0.0313 / secondsPerYear, scaled by 1e18
          const perSec = (0.0313 / (365 * 24 * 3600)) * 1e18;
          return BigInt(Math.round(perSec));
        }
      }
      throw new Error(`unexpected call: ${functionName} on ${address}`);
    });

    await getApy({ chain: 'base' });

    const json = parseLastJson(stdoutCap.chunks) as {
      blendedApyPct: string;
      adapters: Array<{ protocol: string; apyPct: string | null }>;
    };
    expect(json.adapters).toHaveLength(3);
    const morpho = json.adapters.find((a) => a.protocol.includes('Morpho'));
    const aave = json.adapters.find((a) => a.protocol.includes('Aave'));
    const compound = json.adapters.find((a) => a.protocol.includes('Compound'));
    expect(morpho?.apyPct).toBe('5.05%');
    expect(aave?.apyPct).toBe('2.64%');
    expect(compound?.apyPct).toBe('3.13%');
    // blended = (5.05 + 2.64 + 3.13) / 3 = 3.6066...
    expect(json.blendedApyPct).toBe('3.61%');
  });
});
