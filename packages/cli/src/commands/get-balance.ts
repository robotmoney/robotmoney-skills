import type { Address } from 'viem';
import { ADDRESSES } from '../lib/addresses.js';
import { VAULT_ABI } from '../lib/abi.js';
import { createRpcClient } from '../lib/rpc.js';
import { emitJson, formatShares, formatUsdc } from '../lib/format.js';
import type { GlobalFlags } from '../lib/args.js';

export async function getBalance(flags: GlobalFlags, userAddress: Address): Promise<void> {
  const { client } = createRpcClient(flags);
  const addrs = ADDRESSES[flags.chain];
  const vaultCalls = { address: addrs.vault, abi: VAULT_ABI } as const;

  const shares = (await client.readContract({
    ...vaultCalls,
    functionName: 'balanceOf',
    args: [userAddress],
  })) as bigint;

  let gross = 0n;
  let net = 0n;
  if (shares > 0n) {
    [gross, net] = (await Promise.all([
      client.readContract({ ...vaultCalls, functionName: 'convertToAssets', args: [shares] }),
      client.readContract({ ...vaultCalls, functionName: 'previewRedeem', args: [shares] }),
    ])) as [bigint, bigint];
  }
  const fee = gross >= net ? gross - net : 0n;

  emitJson(
    {
      user: userAddress,
      shares: formatShares(shares),
      sharesRaw: shares.toString(),
      grossValueUsdc: formatUsdc(gross),
      grossValueUsdcRaw: gross.toString(),
      netValueUsdc: formatUsdc(net),
      netValueUsdcRaw: net.toString(),
      exitFeeUsdc: formatUsdc(fee),
      exitFeeUsdcRaw: fee.toString(),
    },
    { pretty: flags.pretty ?? false },
  );
}
