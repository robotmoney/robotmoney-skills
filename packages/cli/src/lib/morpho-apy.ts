import { MORPHO_GAUNTLET_USDC_PRIME_BASE } from './addresses.js';

const PRIMARY = 'https://api.morpho.org/graphql';
const FALLBACK = 'https://blue.morpho.org/graphql';

const QUERY = `query VaultApy($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    state { netApy apy totalAssets }
  }
}`;

export interface MorphoApyResult {
  netApy: number | null;
  source: 'primary' | 'fallback' | 'none';
  warning?: string;
}

async function tryEndpoint(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { address: MORPHO_GAUNTLET_USDC_PRIME_BASE, chainId: 8453 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { vaultByAddress?: { state?: { netApy?: number | null } | null } | null };
    };
    const apy = body.data?.vaultByAddress?.state?.netApy;
    if (typeof apy !== 'number' || !Number.isFinite(apy)) return null;
    return apy;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchMorphoNetApy(): Promise<MorphoApyResult> {
  const primary = await tryEndpoint(PRIMARY);
  if (primary !== null) return { netApy: primary, source: 'primary' };
  const fallback = await tryEndpoint(FALLBACK);
  if (fallback !== null) return { netApy: fallback, source: 'fallback' };
  return {
    netApy: null,
    source: 'none',
    warning: 'Morpho GraphQL API unreachable; Morpho APY excluded from blended calculation.',
  };
}
