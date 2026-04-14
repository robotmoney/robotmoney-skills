import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchMorphoNetApy } from '../src/lib/morpho-apy.js';

describe('fetchMorphoNetApy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns netApy from primary endpoint', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { vaultByAddress: { state: { netApy: 0.0505 } } } }),
    });

    const result = await fetchMorphoNetApy();
    expect(result.source).toBe('primary');
    expect(result.netApy).toBe(0.0505);
  });

  test('falls back when primary fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { vaultByAddress: { state: { netApy: 0.048 } } } }),
      });

    const result = await fetchMorphoNetApy();
    expect(result.source).toBe('fallback');
    expect(result.netApy).toBe(0.048);
  });

  test('returns null netApy with a warning when both endpoints fail', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    const result = await fetchMorphoNetApy();
    expect(result.source).toBe('none');
    expect(result.netApy).toBeNull();
    expect(result.warning).toBeDefined();
  });

  test('returns null when GraphQL payload is malformed', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });
    const result = await fetchMorphoNetApy();
    expect(result.netApy).toBeNull();
  });
});
