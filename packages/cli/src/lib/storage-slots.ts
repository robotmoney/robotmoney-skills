import { keccak256, encodeAbiParameters, pad, type Address, type Hex } from 'viem';

// USDC on Base is a Circle FiatTokenV2_2 proxy. The `allowed` mapping lives at
// storage slot 10 of the implementation. Verified on-chain by computing
// keccak256(pad32(spender) ++ keccak256(pad32(owner) ++ pad32(10))) for a known
// allowance and comparing eth_getStorageAt against allowance(owner, spender).
export const USDC_ALLOWANCE_MAPPING_SLOT = 10n;

/**
 * Compute the storage slot where `USDC.allowed[owner][spender]` is kept.
 * Used with viem's `stateOverride` so we can simulate a post-approve tx
 * without waiting for the approval to actually land on-chain.
 */
export function usdcAllowanceSlot(owner: Address, spender: Address): Hex {
  const innerKey = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [owner, USDC_ALLOWANCE_MAPPING_SLOT],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, innerKey]),
  );
}

/** Encode a uint256 allowance value as a 32-byte hex string for stateOverride. */
export function encodeAllowanceValue(amount: bigint): Hex {
  return pad(`0x${amount.toString(16)}` as Hex, { size: 32 });
}
