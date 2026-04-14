import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { captureStdout, captureStderr, makeMockClient, type MockReadHandler } from './helpers.js';

vi.mock('../src/lib/rpc.js', () => ({
  createRpcClient: vi.fn(),
  resolveRpcUrl: vi.fn(() => ({ url: 'http://mock', source: 'flag' })),
}));

import { createRpcClient } from '../src/lib/rpc.js';
import { prepareDeposit } from '../src/commands/prepare-deposit.js';
import { prepareRedeem } from '../src/commands/prepare-redeem.js';
import { prepareWithdraw } from '../src/commands/prepare-withdraw.js';
import { ADDRESSES } from '../src/lib/addresses.js';

const addrs = ADDRESSES.base;
const user = '0x0000000000000000000000000000000000000001' as const;

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

describe('prepare-deposit', () => {
  test('emits approve + deposit when allowance is insufficient', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'allowance':
          return 0n;
        case 'tvlCap':
          return 500_000_000n;
        case 'perDepositCap':
          return 100_000_000n;
        case 'totalAssets':
          return 0n;
        case 'paused':
          return false;
        case 'shutdown':
          return false;
        case 'previewDeposit':
          return 10_000_000n;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await prepareDeposit(
      { chain: 'base' },
      { userAddress: user, amount: '10', receiver: user },
    );

    const json = parseLastJson(stdoutCap.chunks) as {
      operation: {
        type: string;
        transactions: Array<{ to: string; description: string }>;
        warnings: string[];
      };
      simulation: { preview: { sharesToMint: string } | null };
    };
    expect(json.operation.type).toBe('deposit');
    expect(json.operation.transactions).toHaveLength(2);
    expect(json.operation.transactions[0]!.to.toLowerCase()).toBe(addrs.usdc.toLowerCase());
    expect(json.operation.transactions[0]!.description).toContain('approve');
    expect(json.operation.transactions[1]!.to.toLowerCase()).toBe(addrs.vault.toLowerCase());
    expect(json.operation.transactions[1]!.description).toContain('deposit');
    expect(json.simulation.preview?.sharesToMint).toBe('10');
  });

  test('skips approve when allowance already covers amount', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'allowance':
          return 100_000_000n;
        case 'tvlCap':
          return 500_000_000n;
        case 'perDepositCap':
          return 100_000_000n;
        case 'totalAssets':
          return 0n;
        case 'paused':
          return false;
        case 'shutdown':
          return false;
        case 'previewDeposit':
          return 10_000_000n;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await prepareDeposit(
      { chain: 'base' },
      { userAddress: user, amount: '10', receiver: user },
    );

    const json = parseLastJson(stdoutCap.chunks) as {
      operation: { transactions: unknown[] };
    };
    expect(json.operation.transactions).toHaveLength(1);
  });

  test('warns when amount exceeds perDepositCap', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'allowance':
          return 0n;
        case 'tvlCap':
          return 500_000_000n;
        case 'perDepositCap':
          return 100_000_000n;
        case 'totalAssets':
          return 0n;
        case 'paused':
          return false;
        case 'shutdown':
          return false;
        case 'previewDeposit':
          return 150_000_000n;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await prepareDeposit(
      { chain: 'base' },
      { userAddress: user, amount: '150', receiver: user },
    );

    const json = parseLastJson(stdoutCap.chunks) as { operation: { warnings: string[] } };
    expect(json.operation.warnings.some((w) => w.includes('perDepositCap'))).toBe(true);
  });
});

describe('prepare-redeem', () => {
  test('resolves --shares max from balanceOf', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'balanceOf':
          return 100_000_000n;
        case 'convertToAssets':
          return 100_000_000n;
        case 'previewRedeem':
          return 99_750_000n;
        case 'paused':
          return false;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await prepareRedeem(
      { chain: 'base' },
      { userAddress: user, shares: 'max', receiver: user },
    );

    const json = parseLastJson(stdoutCap.chunks) as {
      operation: { type: string; transactions: Array<{ description: string }> };
      simulation: { preview: { grossUsdc: string; feeUsdc: string; netUsdc: string } };
    };
    expect(json.operation.type).toBe('redeem');
    expect(json.operation.transactions).toHaveLength(1);
    expect(json.operation.transactions[0]!.description).toContain('redeem(100000000');
    expect(json.simulation.preview.grossUsdc).toBe('100');
    expect(json.simulation.preview.feeUsdc).toBe('0.25');
    expect(json.simulation.preview.netUsdc).toBe('99.75');
  });
});

describe('prepare-withdraw', () => {
  test('computes shares-needed for a target net amount', async () => {
    mockClientWith(({ functionName }) => {
      switch (functionName) {
        case 'previewWithdraw':
          return 50_125_313n;
        case 'convertToAssets':
          return 50_125_313n;
        case 'paused':
          return false;
        default:
          throw new Error(`unexpected: ${functionName}`);
      }
    });

    await prepareWithdraw(
      { chain: 'base' },
      { userAddress: user, amount: '50', receiver: user },
    );

    const json = parseLastJson(stdoutCap.chunks) as {
      operation: { type: string; transactions: Array<{ description: string }> };
      simulation: { preview: { netUsdc: string; sharesRequired: string } };
    };
    expect(json.operation.type).toBe('withdraw');
    expect(json.operation.transactions[0]!.description).toContain('withdraw(50000000');
    expect(json.simulation.preview.netUsdc).toBe('50');
    expect(json.simulation.preview.sharesRequired).toBe('50.125313');
  });
});
