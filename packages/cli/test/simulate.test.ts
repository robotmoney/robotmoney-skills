import { describe, expect, test, vi } from 'vitest';
import { simulateSequence } from '../src/lib/simulate.js';
import { makeMockClient } from './helpers.js';

const user = '0x0000000000000000000000000000000000000001' as const;
const vault = '0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd' as const;
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

describe('simulateSequence', () => {
  test('passes stateOverride through to estimateGas when provided', async () => {
    const client = makeMockClient(() => null);
    const estimate = vi.fn().mockResolvedValue(1_800_000n);
    (client.estimateGas as unknown) = estimate;

    await simulateSequence(
      client,
      [
        { to: vault, data: '0x1234', value: '0', description: 'deposit' },
      ],
      user,
      {
        overridesByIndex: {
          0: [
            {
              address: usdc,
              stateDiff: [{ slot: '0xabc', value: '0xffff' }],
            },
          ],
        },
      },
    );

    expect(estimate).toHaveBeenCalledTimes(1);
    const callArg = estimate.mock.calls[0]![0] as { stateOverride?: unknown };
    expect(callArg.stateOverride).toBeDefined();
  });

  test('marks post-approval failure as expected when no override is supplied', async () => {
    const client = makeMockClient(() => null);
    let call = 0;
    (client.estimateGas as unknown) = vi.fn(async () => {
      call++;
      if (call === 1) return 60000n; // approve succeeds
      throw new Error('Execution reverted: ERC20: transfer amount exceeds allowance');
    });

    const result = await simulateSequence(
      client,
      [
        { to: usdc, data: '0x1', value: '0', description: 'approve' },
        { to: vault, data: '0x2', value: '0', description: 'deposit' },
      ],
      user,
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.expected).toBe(true);
    // "Expected" failures don't count toward allSucceeded
    expect(result.allSucceeded).toBe(true);
    expect(result.notes).toBeDefined();
  });

  test('real failures flip allSucceeded to false', async () => {
    const client = makeMockClient(() => null);
    (client.estimateGas as unknown) = vi.fn(async () => {
      throw new Error('Execution reverted: TVLCapExceeded');
    });

    const result = await simulateSequence(
      client,
      [{ to: vault, data: '0x1', value: '0', description: 'deposit alone' }],
      user,
    );

    expect(result.allSucceeded).toBe(false);
    expect(result.failures[0]!.expected).toBeUndefined();
  });
});
