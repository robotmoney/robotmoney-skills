import { describe, expect, test, vi } from 'vitest';
import { checkGasBudget } from '../src/lib/gas.js';
import { makeMockClient } from './helpers.js';

describe('checkGasBudget', () => {
  const user = '0x0000000000000000000000000000000000000001' as const;

  test('no warning when balance comfortably covers gas', async () => {
    const client = makeMockClient(() => null);
    (client.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 16n); // 0.01 ETH
    (client.getGasPrice as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 9n); // 1 gwei

    const result = await checkGasBudget(client, user, 1_800_000n);
    expect(result.warning).toBeNull();
    expect(result.error).toBeNull();
  });

  test('warning when balance is less than 2x gas cost', async () => {
    const client = makeMockClient(() => null);
    // 1 gwei * 1.2 pad * 1.8M = 2.16e15 wei. Set balance to 3e15 (between 1x and 2x).
    (client.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(3n * 10n ** 15n);
    (client.getGasPrice as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 9n);

    const result = await checkGasBudget(client, user, 1_800_000n);
    expect(result.warning).not.toBeNull();
    expect(result.error).toBeNull();
  });

  test('error when balance is below 1x gas cost', async () => {
    const client = makeMockClient(() => null);
    (client.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 14n); // 0.0001 ETH
    (client.getGasPrice as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 9n);

    const result = await checkGasBudget(client, user, 1_800_000n);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('Need at least');
  });
});
