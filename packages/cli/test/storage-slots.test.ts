import { describe, expect, test } from 'vitest';
import { usdcAllowanceSlot, encodeAllowanceValue } from '../src/lib/storage-slots.js';

// Known on-chain verification case: Base mainnet USDC, owner + spender + allowance
// reproduce the same slot the agent computed when building the override.
describe('USDC allowance storage slot', () => {
  test('reproduces the verified slot for a known (owner, spender) pair', () => {
    // This is the worked example from the storage-slot research:
    //   owner:   0xe6D2778e5024F6Ee68761B75Da112cBf45C6C35C
    //   spender: 0x000000000022D473030F116dDEE9F6B43aC78BA3 (Permit2)
    //   slot == 0x902a5fe1c32ef1eef7e3f38ebc8c7b88eb2e04dffcad629bc9e8c8f7a5652e40
    const slot = usdcAllowanceSlot(
      '0xe6D2778e5024F6Ee68761B75Da112cBf45C6C35C',
      '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    );
    expect(slot.toLowerCase()).toBe(
      '0x902a5fe1c32ef1eef7e3f38ebc8c7b88eb2e04dffcad629bc9e8c8f7a5652e40',
    );
  });

  test('different spender yields a different slot', () => {
    const a = usdcAllowanceSlot(
      '0xe6D2778e5024F6Ee68761B75Da112cBf45C6C35C',
      '0x0000000000000000000000000000000000000001',
    );
    const b = usdcAllowanceSlot(
      '0xe6D2778e5024F6Ee68761B75Da112cBf45C6C35C',
      '0x0000000000000000000000000000000000000002',
    );
    expect(a).not.toBe(b);
  });
});

describe('encodeAllowanceValue', () => {
  test('pads a small value to 32 bytes', () => {
    expect(encodeAllowanceValue(100n)).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000064',
    );
  });

  test('handles max uint256', () => {
    const max = (1n << 256n) - 1n;
    expect(encodeAllowanceValue(max)).toBe(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
  });
});
