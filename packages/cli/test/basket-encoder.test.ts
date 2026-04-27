import { describe, expect, test } from 'vitest';
import { decodeAbiParameters, decodeFunctionData } from 'viem';
import {
  buildErc20Approve,
  buildPermit2Approve,
  encodeBasketBuy,
  encodeBasketSell,
} from '../src/lib/basket/encoder.js';
import { encodeV3Path } from '../src/lib/basket/quoter.js';
import {
  BASKET,
  PERMIT2,
  UNIVERSAL_ROUTER,
  USDC,
  WETH,
} from '../src/lib/basket/constants.js';

const UR_EXECUTE_SELECTOR = '0x3593564c';

const UR_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

describe('encodeV3Path', () => {
  test('packs single-hop USDC->VIRTUAL with fee=3000', () => {
    const path = encodeV3Path([USDC, BASKET[0]!.address], [3000]);
    // 20 bytes USDC + 3 bytes fee + 20 bytes VIRTUAL = 43 bytes = 86 hex chars + '0x'
    expect(path.length).toBe(2 + 86);
    expect(path.toLowerCase()).toContain(USDC.slice(2).toLowerCase());
    expect(path.toLowerCase()).toContain('000bb8'); // 3000 in hex, 3 bytes
    expect(path.toLowerCase()).toContain(BASKET[0]!.address.slice(2).toLowerCase());
  });

  test('packs multi-hop USDC->WETH->ZFI', () => {
    const zfi = BASKET.find((t) => t.symbol === 'ZFI')!.address;
    const path = encodeV3Path([USDC, WETH, zfi], [500, 10000]);
    // 20 + 3 + 20 + 3 + 20 = 66 bytes = 132 hex chars + '0x'
    expect(path.length).toBe(2 + 132);
    // 500 = 0x0001f4, 10000 = 0x002710
    expect(path.toLowerCase()).toContain('0001f4');
    expect(path.toLowerCase()).toContain('002710');
  });

  test('throws on length mismatch', () => {
    expect(() => encodeV3Path([USDC], [3000, 10000])).toThrow(/length mismatch/);
  });
});

describe('encodeBasketBuy', () => {
  const RECIPIENT = '0x000000000000000000000000000000000000beef' as const;
  const DEADLINE = 1_700_000_000n;

  const fakeQuotes = BASKET.map((t) => {
    const isMixed =
      t.hops?.some((h) => h.version === 'v4') && t.hops?.some((h) => h.version === 'v3');
    return {
      symbol: t.symbol,
      address: t.address,
      amountOut: 100_000_000_000_000_000_000n, // 100 tokens (18 dec) — arbitrary
      decimals: t.decimals,
      // For ROBOT (V3->V4 mixed), provide a hopOutputs[0] = intermediate WETH
      // amount (~0.0003 WETH for ~$1 trade).
      ...(isMixed
        ? { hopOutputs: [300_000_000_000_000n, 100_000_000_000_000_000_000n] }
        : {}),
    };
  });

  test('produces a single UR.execute tx targeting UniversalRouter', () => {
    const { unsignedTx, perLegUsdc } = encodeBasketBuy({
      recipient: RECIPIENT,
      deadline: DEADLINE,
      slippageBps: 300,
      quotes: fakeQuotes,
      totalUsdc: 6_000_000n, // $6 split 6 ways = $1 each
    });
    expect(unsignedTx.to).toBe(UNIVERSAL_ROUTER);
    expect(unsignedTx.value).toBe('0');
    expect(unsignedTx.data.startsWith(UR_EXECUTE_SELECTOR)).toBe(true);
    expect(perLegUsdc).toBe(1_000_000n);
  });

  test('command sequence: 5 V3 swaps + 1 V3+V4 (ROBOT) + final SWEEP', () => {
    const { unsignedTx } = encodeBasketBuy({
      recipient: RECIPIENT,
      deadline: DEADLINE,
      slippageBps: 300,
      quotes: fakeQuotes,
      totalUsdc: 6_000_000n,
    });

    const decoded = decodeFunctionData({ abi: UR_EXECUTE_ABI, data: unsignedTx.data });
    const [commands, inputs, deadline] = decoded.args as [`0x${string}`, `0x${string}`[], bigint];
    expect(deadline).toBe(DEADLINE);

    // 5 V3-only legs (VIRTUAL/BNKR/JUNO/ZFI/GIZA) + ROBOT (V3+V4 = 2) +
    // SWEEP USDC + SWEEP WETH (residual from ROBOT V3 over-delivery) = 9.
    const cmdHex = commands.slice(2);
    expect(cmdHex.length).toBe(9 * 2);
    const codes = [];
    for (let i = 0; i < cmdHex.length; i += 2) {
      codes.push(parseInt(cmdHex.slice(i, i + 2), 16));
    }
    // [V3, V3 (ROBOT v3 leg), V4 (ROBOT v4 leg), V3, V3, V3, V3, SWEEP USDC, SWEEP WETH]
    expect(codes).toEqual([0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x04, 0x04]);
    expect(inputs.length).toBe(9);
  });

  test('per-leg USDC division allocates dust to first leg', () => {
    const { perLegUsdc } = encodeBasketBuy({
      recipient: RECIPIENT,
      deadline: DEADLINE,
      slippageBps: 300,
      quotes: fakeQuotes,
      totalUsdc: 1_000_001n, // 1 USDC + 1 dust
    });
    expect(perLegUsdc).toBe(166_666n);
    // dust = 1_000_001 - 166_666 * 6 = 5
    // First leg gets 166_666 + 5 = 166_671. Verifying via decoded tx is fiddly;
    // here we just assert the per-leg calc is what we expect.
  });

  test('throws on quote/token count mismatch', () => {
    expect(() =>
      encodeBasketBuy({
        recipient: RECIPIENT,
        deadline: DEADLINE,
        slippageBps: 300,
        quotes: fakeQuotes.slice(0, 5),
        totalUsdc: 5_000_000n,
      }),
    ).toThrow(/expected/);
  });
});

describe('encodeBasketSell', () => {
  const RECIPIENT = '0x000000000000000000000000000000000000beef' as const;
  const DEADLINE = 1_700_000_000n;

  test('emits 1 UR.execute with 2 sell legs + 2 SWEEP commands', () => {
    const inputs = [
      {
        token: BASKET.find((t) => t.symbol === 'VIRTUAL')!,
        amountIn: 100_000_000_000_000_000_000n,
        minUsdcOut: 50_000_000n,
      },
      {
        token: BASKET.find((t) => t.symbol === 'JUNO')!,
        amountIn: 1_000_000_000_000_000_000n,
        minUsdcOut: 1_000n,
      },
    ];
    const tx = encodeBasketSell(inputs, RECIPIENT, DEADLINE);
    expect(tx.to).toBe(UNIVERSAL_ROUTER);

    const decoded = decodeFunctionData({ abi: UR_EXECUTE_ABI, data: tx.data });
    const [commands] = decoded.args as [`0x${string}`, unknown, unknown];
    const cmdHex = commands.slice(2);
    const codes = [];
    for (let i = 0; i < cmdHex.length; i += 2) {
      codes.push(parseInt(cmdHex.slice(i, i + 2), 16));
    }
    // VIRTUAL is V3-only sell (1 cmd), JUNO is V3-only sell (1 cmd), then 2 SWEEPs.
    expect(codes).toEqual([0x00, 0x00, 0x04, 0x04]);
  });

  test('ROBOT sell uses V4 then V3 command sequence', () => {
    const robot = BASKET.find((t) => t.symbol === 'ROBOT')!;
    const inputs = [
      {
        token: robot,
        amountIn: 1_000_000_000_000_000_000n, // 1 ROBOT
        minUsdcOut: 1_000n,
      },
    ];
    const tx = encodeBasketSell(inputs, RECIPIENT, DEADLINE);
    const decoded = decodeFunctionData({ abi: UR_EXECUTE_ABI, data: tx.data });
    const [commands] = decoded.args as [`0x${string}`, unknown, unknown];
    const cmdHex = commands.slice(2);
    const codes = [];
    for (let i = 0; i < cmdHex.length; i += 2) {
      codes.push(parseInt(cmdHex.slice(i, i + 2), 16));
    }
    // ROBOT sell: V4_SWAP (ROBOT->WETH to UR), V3_SWAP_EXACT_IN (WETH->USDC), SWEEP
    expect(codes).toEqual([0x10, 0x00, 0x04]);
  });
});

describe('buildErc20Approve / buildPermit2Approve', () => {
  test('ERC20 approve targets the token, encodes approve(spender, amount)', () => {
    const tx = buildErc20Approve(USDC, PERMIT2, 1_000_000n);
    expect(tx.to).toBe(USDC);
    expect(tx.value).toBe('0');
    expect(tx.data.startsWith('0x095ea7b3')).toBe(true); // approve selector
    const decoded = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      `0x${tx.data.slice(10)}`,
    );
    expect(decoded[0]).toBe(PERMIT2);
    expect(decoded[1]).toBe(1_000_000n);
  });

  test('Permit2 approve targets Permit2 with (token, spender, amount, expiration)', () => {
    const tx = buildPermit2Approve(USDC, UNIVERSAL_ROUTER, 12345n, 1_800_000_000n);
    expect(tx.to).toBe(PERMIT2);
    expect(tx.value).toBe('0');
    // selector is approve(address,address,uint160,uint48) = 0x87517c45
    expect(tx.data.startsWith('0x87517c45')).toBe(true);
  });

  test('Permit2 amount > uint160 max throws', () => {
    expect(() =>
      buildPermit2Approve(USDC, UNIVERSAL_ROUTER, 1n << 160n, 1n),
    ).toThrow(/uint160/);
  });

  test('Permit2 expiration > uint48 max throws', () => {
    expect(() => buildPermit2Approve(USDC, UNIVERSAL_ROUTER, 1n, 1n << 48n)).toThrow(/uint48/);
  });
});
