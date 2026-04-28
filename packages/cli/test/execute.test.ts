import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PublicClient } from 'viem';

vi.mock('../src/lib/wallet.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/wallet.js')>('../src/lib/wallet.js');
  return {
    ...actual,
    owsSignAndSend: vi.fn(),
  };
});

import { signAndSendSequence } from '../src/lib/execute.js';
import { owsSignAndSend } from '../src/lib/wallet.js';
import type { UnsignedTx } from '../src/lib/simulate.js';

const owsMock = owsSignAndSend as unknown as ReturnType<typeof vi.fn>;

const user = '0x0000000000000000000000000000000000000001' as const;
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const ur = '0x6fF5693b99212Da76ad316178A184AB56D299b43' as const;

function makeBroadcastClient(estimate: (tx: UnsignedTx, i: number) => Promise<bigint>): {
  client: PublicClient;
  estimateCalls: number;
  receiptCalls: number;
} {
  let estimateCalls = 0;
  let receiptCalls = 0;
  let i = 0;
  const client: Partial<PublicClient> = {
    estimateGas: vi.fn(async (params: unknown) => {
      const idx = i++;
      estimateCalls++;
      return estimate(params as unknown as UnsignedTx, idx);
    }) as PublicClient['estimateGas'],
    getTransactionCount: vi.fn(async () => 42) as PublicClient['getTransactionCount'],
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 6n,
    })) as PublicClient['estimateFeesPerGas'],
    waitForTransactionReceipt: vi.fn(async () => {
      receiptCalls++;
      return {
        status: 'success',
        blockNumber: 1n,
        gasUsed: 100_000n,
      };
    }) as unknown as PublicClient['waitForTransactionReceipt'],
  };
  return {
    client: client as PublicClient,
    get estimateCalls() {
      return estimateCalls;
    },
    get receiptCalls() {
      return receiptCalls;
    },
  };
}

const baseCtx = (client: PublicClient) => ({
  client,
  user,
  walletName: 'test-wallet',
  passphrase: undefined,
  rpcUrl: 'http://mock',
});

beforeEach(() => {
  owsMock.mockReset();
  owsMock.mockImplementation(async () => ({
    txHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  }));
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('signAndSendSequence', () => {
  test('uses fallbackGasByIndex when a dependent tx fails estimation', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'USDC.approve(Permit2)' },
      { to: ur, data: '0x02', value: '0', description: 'UR.execute(buy)' },
    ];

    const meta = makeBroadcastClient(async (_tx, idx) => {
      if (idx === 0) return 50_000n;
      throw new Error('execution reverted: TRANSFER_FROM_FAILED');
    });

    const result = await signAndSendSequence(baseCtx(meta.client), txs, {
      fallbackGasByIndex: { 1: 1_500_000n },
    });

    expect(result).toHaveLength(2);
    expect(owsMock).toHaveBeenCalledTimes(2);

    // Second tx still got a serializedTx — we didn't abort on the failed
    // estimate, the fallback gas was used instead.
    const secondCall = owsMock.mock.calls[1]![0] as { serializedTx: string };
    expect(secondCall.serializedTx).toBeDefined();
    expect(meta.estimateCalls).toBe(2);
  });

  test('aborts cleanly when tx[0] fails estimation — nothing is broadcast', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'USDC.approve(vault)' },
      { to: usdc, data: '0x02', value: '0', description: 'vault.deposit' },
    ];

    const meta = makeBroadcastClient(async () => {
      throw new Error('execution reverted: insufficient balance');
    });

    await expect(
      signAndSendSequence(baseCtx(meta.client), txs, {
        fallbackGasByIndex: { 1: 1_500_000n },
      }),
    ).rejects.toThrow(/No transactions were broadcast/);

    expect(owsMock).not.toHaveBeenCalled();
  });

  test('aborts when a dependent tx fails AND no fallback is supplied', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'approve' },
      { to: ur, data: '0x02', value: '0', description: 'UR.execute' },
    ];

    const meta = makeBroadcastClient(async (_tx, idx) => {
      if (idx === 0) return 50_000n;
      throw new Error('execution reverted: insufficient allowance');
    });

    await expect(
      signAndSendSequence(baseCtx(meta.client), txs),
    ).rejects.toThrow(/No transactions were broadcast/);

    expect(owsMock).not.toHaveBeenCalled();
  });

  test('all estimates run BEFORE any broadcast (no partial state on abort)', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'tx0' },
      { to: usdc, data: '0x02', value: '0', description: 'tx1' },
      { to: usdc, data: '0x03', value: '0', description: 'tx2' },
    ];

    const meta = makeBroadcastClient(async (_tx, idx) => {
      if (idx === 2) throw new Error('execution reverted: bad');
      return 100_000n;
    });

    await expect(
      signAndSendSequence(baseCtx(meta.client), txs),
    ).rejects.toThrow(/No transactions were broadcast/);

    // All three estimates ran; nothing was signed.
    expect(meta.estimateCalls).toBe(3);
    expect(owsMock).not.toHaveBeenCalled();
  });

  test('happy path: all estimates succeed, all txs broadcast', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'a' },
      { to: usdc, data: '0x02', value: '0', description: 'b' },
    ];

    const meta = makeBroadcastClient(async () => 80_000n);
    const result = await signAndSendSequence(baseCtx(meta.client), txs);

    expect(result).toHaveLength(2);
    expect(result[0]!.status).toBe('confirmed');
    expect(owsMock).toHaveBeenCalledTimes(2);
  });

  test('passes per-tx state override to estimateGas', async () => {
    const txs: UnsignedTx[] = [
      { to: usdc, data: '0x01', value: '0', description: 'tx0' },
    ];

    const seenParams: unknown[] = [];
    const client = {
      estimateGas: vi.fn(async (params: unknown) => {
        seenParams.push(params);
        return 50_000n;
      }),
      getTransactionCount: vi.fn(async () => 1),
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 1n,
        gasUsed: 50_000n,
      })),
    } as unknown as PublicClient;

    await signAndSendSequence(baseCtx(client), txs, {
      overridesByIndex: {
        0: [{ address: usdc, stateDiff: [{ slot: '0xabc', value: '0xff' }] }],
      },
    });

    const params = seenParams[0] as { stateOverride?: unknown };
    expect(params.stateOverride).toBeDefined();
  });
});
