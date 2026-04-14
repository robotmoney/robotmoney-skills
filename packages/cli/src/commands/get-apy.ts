import { ADDRESSES } from '../lib/addresses.js';
import { AAVE_POOL_ABI, COMET_ABI, VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatPct } from '../lib/format.js';
import { fetchMorphoNetApy } from '../lib/morpho-apy.js';
import type { GlobalFlags } from '../lib/args.js';

// Aave V3 ray = 1e27. APY = rate / 1e27 (already per-year).
function aaveRayToApy(rayPerYear: bigint): number {
  return Number(rayPerYear) / 1e27;
}

// Compound V3: getSupplyRate returns rate per second scaled by 1e18.
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
function cometRateToApy(ratePerSecondScaled: bigint): number {
  return (Number(ratePerSecondScaled) / 1e18) * SECONDS_PER_YEAR;
}

interface AdapterRow {
  index: number;
  protocol: string;
  address: `0x${string}`;
  apy: number | null;
  apyPct: string | null;
  weight: number;
}

export async function getApy(flags: GlobalFlags): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];

  const adapterCount = (await client.readContract({
    address: addrs.vault,
    abi: VAULT_ABI,
    functionName: 'adapterCount',
  })) as bigint;

  const infos = await Promise.all(
    Array.from({ length: Number(adapterCount) }, (_, i) =>
      client.readContract({
        address: addrs.vault,
        abi: VAULT_ABI,
        functionName: 'getAdapterInfo',
        args: [BigInt(i)],
      }),
    ),
  );

  const activeIndexes: number[] = [];
  const active: Array<{ index: number; address: `0x${string}` }> = [];
  for (let i = 0; i < infos.length; i++) {
    const [adapterAddr, , isActive] = infos[i] as readonly [`0x${string}`, number, boolean, bigint, bigint];
    if (isActive) {
      activeIndexes.push(i);
      active.push({ index: i, address: adapterAddr });
    }
  }
  const weight = active.length > 0 ? 1 / active.length : 0;

  const [aaveData, cometUtil, morphoRes] = await Promise.all([
    client
      .readContract({
        address: addrs.aavePool,
        abi: AAVE_POOL_ABI,
        functionName: 'getReserveData',
        args: [addrs.usdc],
      })
      .catch(() => null),
    client
      .readContract({ address: addrs.compoundComet, abi: COMET_ABI, functionName: 'getUtilization' })
      .catch(() => null),
    fetchMorphoNetApy(),
  ]);

  let cometSupplyRate: bigint | null = null;
  if (cometUtil !== null) {
    cometSupplyRate = (await client
      .readContract({
        address: addrs.compoundComet,
        abi: COMET_ABI,
        functionName: 'getSupplyRate',
        args: [cometUtil as bigint],
      })
      .catch(() => null)) as bigint | null;
  }

  const rows: AdapterRow[] = active.map(({ index, address }) => {
    let protocol = 'unknown';
    let apy: number | null = null;

    if (address.toLowerCase() === addrs.morphoAdapter.toLowerCase()) {
      protocol = 'Morpho Gauntlet USDC Prime';
      apy = morphoRes.netApy;
    } else if (address.toLowerCase() === addrs.aaveAdapter.toLowerCase()) {
      protocol = 'Aave V3 USDC';
      if (aaveData) {
        const rate = (aaveData as { currentLiquidityRate: bigint }).currentLiquidityRate;
        apy = aaveRayToApy(rate);
      }
    } else if (address.toLowerCase() === addrs.compoundAdapter.toLowerCase()) {
      protocol = 'Compound V3 cUSDCv3';
      if (cometSupplyRate !== null) apy = cometRateToApy(cometSupplyRate);
    }

    return {
      index,
      protocol,
      address,
      apy,
      apyPct: apy === null ? null : formatPct(apy, 2),
      weight,
    };
  });

  const usableRows = rows.filter((r): r is AdapterRow & { apy: number } => r.apy !== null);
  const blendedApy =
    usableRows.length === 0
      ? null
      : usableRows.reduce((acc, r) => acc + r.apy, 0) / usableRows.length;

  const warnings: string[] = [];
  if (morphoRes.warning) warnings.push(morphoRes.warning);
  if (aaveData === null) warnings.push('Aave V3 reserve data unreachable.');
  if (cometSupplyRate === null) warnings.push('Compound V3 supply rate unreachable.');

  emitJson(
    {
      blendedApy: blendedApy === null ? null : blendedApy.toFixed(4),
      blendedApyPct: blendedApy === null ? null : formatPct(blendedApy, 2),
      adapters: rows.map((r) => ({
        index: r.index,
        protocol: r.protocol,
        address: r.address,
        apy: r.apy === null ? null : r.apy.toFixed(4),
        apyPct: r.apyPct,
        weight: r.weight,
      })),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    { pretty: flags.pretty ?? false },
  );
}
