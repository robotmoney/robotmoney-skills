import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI, USDC_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatUsdc } from '../lib/format.js';
import type { GlobalFlags } from '../lib/args.js';

export interface GetVaultOptions {
  verbose: boolean;
}

export async function getVault(
  flags: GlobalFlags,
  options: GetVaultOptions = { verbose: false },
): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];

  const vaultCalls = {
    address: addrs.vault,
    abi: VAULT_ABI,
  } as const;

  const [
    asset,
    totalAssets,
    totalSupply,
    paused,
    shutdown,
    tvlCap,
    perDepositCap,
    exitFeeBps,
    feeRecipient,
    adapterCount,
    usdcSymbol,
    usdcDecimals,
  ] = await Promise.all([
    client.readContract({ ...vaultCalls, functionName: 'asset' }),
    client.readContract({ ...vaultCalls, functionName: 'totalAssets' }),
    client.readContract({ ...vaultCalls, functionName: 'totalSupply' }),
    client.readContract({ ...vaultCalls, functionName: 'paused' }),
    client.readContract({ ...vaultCalls, functionName: 'shutdown' }),
    client.readContract({ ...vaultCalls, functionName: 'tvlCap' }),
    client.readContract({ ...vaultCalls, functionName: 'perDepositCap' }),
    client.readContract({ ...vaultCalls, functionName: 'exitFeeBps' }),
    client.readContract({ ...vaultCalls, functionName: 'feeRecipient' }),
    client.readContract({ ...vaultCalls, functionName: 'adapterCount' }),
    client.readContract({ address: addrs.usdc, abi: USDC_ABI, functionName: 'symbol' }),
    client.readContract({ address: addrs.usdc, abi: USDC_ABI, functionName: 'decimals' }),
  ]);

  const adapters: Array<{
    index: number;
    address: `0x${string}`;
    active: boolean;
    capBps: number;
    currentBalance: string;
    currentBalanceRaw: string;
    targetBps: number;
  }> = [];
  let activeAdapterCount = 0;

  const count = Number(adapterCount);
  if (count > 0) {
    const infos = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        client.readContract({
          ...vaultCalls,
          functionName: 'getAdapterInfo',
          args: [BigInt(i)],
        }),
      ),
    );
    for (let i = 0; i < count; i++) {
      const info = infos[i] as readonly [`0x${string}`, number, boolean, bigint, bigint];
      const [adapterAddr, capBps, active, currentBalance, targetBps] = info;
      if (active) activeAdapterCount++;
      adapters.push({
        index: i,
        address: adapterAddr,
        active,
        capBps: Number(capBps),
        currentBalance: formatUsdc(currentBalance),
        currentBalanceRaw: currentBalance.toString(),
        targetBps: Number(targetBps),
      });
    }
  }

  const currentTargetBps = activeAdapterCount > 0 ? Math.floor(10000 / activeAdapterCount) : 0;

  const sharePrice =
    totalSupply === 0n ? '1.0' : formatUsdc((totalAssets * 10n ** 6n) / totalSupply);

  const out = {
    address: addrs.vault,
    asset: {
      address: asset,
      symbol: usdcSymbol,
      decimals: Number(usdcDecimals),
    },
    shareToken: { symbol: 'rmUSDC', decimals: 6 },
    totalAssets: formatUsdc(totalAssets),
    totalAssetsRaw: totalAssets.toString(),
    totalShares: formatUsdc(totalSupply),
    totalSharesRaw: totalSupply.toString(),
    sharePrice,
    paused,
    shutdown,
    tvlCap: formatUsdc(tvlCap),
    tvlCapRaw: tvlCap.toString(),
    tvlCapReached: totalAssets >= tvlCap,
    perDepositCap: formatUsdc(perDepositCap),
    perDepositCapRaw: perDepositCap.toString(),
    exitFeeBps: Number(exitFeeBps),
    feeRecipient,
    activeAdapterCount,
    currentTargetBps,
    ...(options.verbose ? { adapters } : {}),
  };

  emitJson(out, { pretty: flags.pretty ?? false });
}
