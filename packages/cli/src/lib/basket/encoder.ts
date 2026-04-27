import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hex,
} from 'viem';
import {
  BASKET,
  PERMIT2,
  UNIVERSAL_ROUTER,
  USDC,
  WETH,
  type BasketTokenConfig,
  type SingleHopPool,
} from './constants.js';
import { applySlippage, encodeV3Path, type BasketQuote } from './quoter.js';

// ---------- UR command codes ----------
const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_SWEEP = 0x04;
const CMD_V4_SWAP = 0x10;

// ---------- V4 action codes ----------
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_PORTION = 0x10;
const ACT_TAKE_ALL = 0x0f;

// ---------- UR magic addresses ----------
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

// V3_SWAP_EXACT_IN amountIn marker: when payerIsUser=false, this tells UR to
// use its current balance of the path's first token instead of a fixed amount.
const V3_CONTRACT_BALANCE = 1n << 255n;

// ---------- ABIs (minimal slices) ----------
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

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

// ---------- UR command-input encoders ----------

function encodeV3SwapExactIn(
  recipient: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  path: Hex,
  payerIsUser: boolean,
): Hex {
  return encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'bool' },
    ],
    [recipient, amountIn, amountOutMin, path, payerIsUser],
  );
}

function encodeSweep(token: Address, recipient: Address, minAmount: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [token, recipient, minAmount],
  );
}

// ---------- V4 action-param encoders ----------

interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

function encodeSwapExactInSingle(
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
  hookData: Hex,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: amountOutMin, hookData }],
  );
}

function encodeSettleAll(currency: Address, maxAmount: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [currency, maxAmount],
  );
}

function encodeSettle(currency: Address, amount: bigint, payerIsUser: boolean): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
    [currency, amount, payerIsUser],
  );
}

function encodeTakeAll(currency: Address, minAmount: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [currency, minAmount],
  );
}

// TAKE_PORTION takes a percentage (in bps) of the current credit and sends it
// to `recipient`. With bips=10000 it takes 100% — effectively "TAKE_ALL but
// with explicit recipient (so we can route to UR for further processing)".
function encodeTakePortion(currency: Address, recipient: Address, bips: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [currency, recipient, bips],
  );
}

// V4_SWAP UR-input is abi.encode(bytes actions, bytes[] params).
function encodeV4SwapInput(actionCodes: number[], params: Hex[]): Hex {
  const actions = ('0x' + actionCodes.map((c) => c.toString(16).padStart(2, '0')).join('')) as Hex;
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, params],
  );
}

// ---------- Helpers ----------

function sortPair(a: Address, b: Address): { c0: Address; c1: Address; aIsZero: boolean } {
  return a.toLowerCase() < b.toLowerCase()
    ? { c0: a, c1: b, aIsZero: true }
    : { c0: b, c1: a, aIsZero: false };
}

function commandsBytes(codes: number[]): Hex {
  return ('0x' + codes.map((c) => c.toString(16).padStart(2, '0')).join('')) as Hex;
}

// ---------- Per-token leg builders ----------

interface LegPlan {
  commands: number[];
  inputs: Hex[];
}

// Build UR commands for buying ONE basket token from USDC.
// Pure V3 path: a single V3_SWAP_EXACT_IN delivering directly to recipient.
// Mixed V3->V4 path (ROBOT): V3 swap into UR with a slippage-tolerant minimum,
// then V4_SWAP draws exactly that minimum from UR via SETTLE_ALL. Any V3
// over-delivery stays as residual WETH and is swept at the end.
function buildBuyLeg(
  token: BasketTokenConfig,
  usdcAmount: bigint,
  minOut: bigint,
  recipient: Address,
  intermediateMin?: bigint, // V3 leg's minimum output (= V4 leg's amountIn) for mixed paths
): LegPlan {
  if (!token.pathTokens || !token.hops) throw new Error(`${token.symbol} missing routing`);
  const hops = token.hops;

  const allV3 = hops.every((h) => h.version === 'v3');
  if (allV3) {
    const v3Fees = hops.map((h) => (h as Extract<SingleHopPool, { version: 'v3' }>).fee);
    const path = encodeV3Path(token.pathTokens, v3Fees);
    return {
      commands: [CMD_V3_SWAP_EXACT_IN],
      inputs: [encodeV3SwapExactIn(recipient, usdcAmount, minOut, path, /* payerIsUser */ true)],
    };
  }

  if (
    hops.length === 2 &&
    hops[0]!.version === 'v3' &&
    hops[1]!.version === 'v4' &&
    token.pathTokens.length === 3
  ) {
    if (intermediateMin === undefined || intermediateMin === 0n) {
      throw new Error(
        `${token.symbol}: mixed V3->V4 path requires intermediateMin (V3 leg's minimum output)`,
      );
    }
    const v3Hop = hops[0] as Extract<SingleHopPool, { version: 'v3' }>;
    const v4Hop = hops[1] as Extract<SingleHopPool, { version: 'v4' }>;
    const usdcAddr = token.pathTokens[0]!;
    const wethAddr = token.pathTokens[1]!;
    const tokenAddr = token.pathTokens[2]!;

    // V3 leg: USDC -> WETH, recipient = UR. amountOutMin = intermediateMin so
    // we know UR receives at least that many WETH; if V3 reverts here, the
    // whole UR.execute reverts before we touch V4.
    const v3Path = encodeV3Path([usdcAddr, wethAddr], [v3Hop.fee]);
    const v3Input = encodeV3SwapExactIn(
      ADDRESS_THIS,
      usdcAmount,
      intermediateMin,
      v3Path,
      /* payerIsUser */ true,
    );

    // V4 leg: WETH -> ROBOT. amountIn = intermediateMin (we know UR has at
    // least this much WETH). Any over-delivery from V3 stays in UR and gets
    // swept at the end. amountOutMin = minOut applies the chained slippage.
    const { c0, c1, aIsZero } = sortPair(wethAddr, tokenAddr);
    const v4SwapParam = encodeSwapExactInSingle(
      { currency0: c0, currency1: c1, fee: v4Hop.fee, tickSpacing: v4Hop.tickSpacing, hooks: v4Hop.hooks },
      aIsZero,
      intermediateMin,
      minOut,
      '0x',
    );
    // Important: SETTLE_ALL would pass msgSender() (the user) as payer and pull
    // WETH via Permit2. We need UR to pay from its own balance (V3 deposited
    // the WETH into UR), so use SETTLE with payerIsUser=false. amount=0 means
    // OPEN_DELTA -> pay the full current debt (= V4 swap's input amount).
    const v4SettleParam = encodeSettle(wethAddr, 0n, /* payerIsUser */ false);
    const v4TakeParam = encodeTakeAll(tokenAddr, minOut);
    const v4Input = encodeV4SwapInput(
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL],
      [v4SwapParam, v4SettleParam, v4TakeParam],
    );

    return {
      commands: [CMD_V3_SWAP_EXACT_IN, CMD_V4_SWAP],
      inputs: [v3Input, v4Input],
    };
  }

  throw new Error(`Unsupported routing for ${token.symbol}`);
}

// Build UR commands for selling ONE basket token to USDC. Reverses the buy path.
function buildSellLeg(
  token: BasketTokenConfig,
  amountIn: bigint,
  minUsdcOut: bigint,
  recipient: Address,
): LegPlan {
  if (!token.pathTokens || !token.hops) throw new Error(`${token.symbol} missing routing`);
  const reverseTokens = [...token.pathTokens].reverse();
  const reverseHops = [...token.hops].reverse();

  const allV3 = reverseHops.every((h) => h.version === 'v3');
  if (allV3) {
    const v3Fees = reverseHops.map((h) => (h as Extract<SingleHopPool, { version: 'v3' }>).fee);
    const path = encodeV3Path(reverseTokens, v3Fees);
    return {
      commands: [CMD_V3_SWAP_EXACT_IN],
      inputs: [encodeV3SwapExactIn(recipient, amountIn, minUsdcOut, path, true)],
    };
  }

  // Mixed sell — ROBOT pattern reversed: V4 ROBOT -> WETH (to UR), then V3 WETH -> USDC (to recipient).
  if (
    reverseHops.length === 2 &&
    reverseHops[0]!.version === 'v4' &&
    reverseHops[1]!.version === 'v3' &&
    reverseTokens.length === 3
  ) {
    const v4Hop = reverseHops[0] as Extract<SingleHopPool, { version: 'v4' }>;
    const v3Hop = reverseHops[1] as Extract<SingleHopPool, { version: 'v3' }>;
    const tokenAddr = reverseTokens[0]!;
    const wethAddr = reverseTokens[1]!;
    const usdcAddr = reverseTokens[2]!;

    const { c0, c1, aIsZero } = sortPair(tokenAddr, wethAddr);
    const v4SwapParam = encodeSwapExactInSingle(
      { currency0: c0, currency1: c1, fee: v4Hop.fee, tickSpacing: v4Hop.tickSpacing, hooks: v4Hop.hooks },
      aIsZero,
      amountIn,
      /* WETH minOut on the swap itself; tighter check happens via V3 leg */ 0n,
      '0x',
    );
    // SETTLE pays the ROBOT debt by pulling from the user via Permit2.
    const v4SettleParam = encodeSettle(tokenAddr, amountIn, /* payerIsUser */ true);
    // TAKE_PORTION takes 100% of the WETH credit and sends it to UR (not the
    // user; TAKE_ALL would default to msgSender). UR holds WETH for the V3 leg.
    const v4TakeParam = encodeTakePortion(wethAddr, ADDRESS_THIS, 10_000n);
    const v4Input = encodeV4SwapInput(
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_PORTION],
      [v4SwapParam, v4SettleParam, v4TakeParam],
    );

    // V3 leg: WETH -> USDC, recipient = user, payerIsUser = false. The
    // CONTRACT_BALANCE marker (1<<255) tells UR to use its WETH balance.
    const v3Path = encodeV3Path([wethAddr, usdcAddr], [v3Hop.fee]);
    const v3Input = encodeV3SwapExactIn(
      recipient,
      V3_CONTRACT_BALANCE,
      minUsdcOut,
      v3Path,
      /* payerIsUser */ false,
    );

    return {
      commands: [CMD_V4_SWAP, CMD_V3_SWAP_EXACT_IN],
      inputs: [v4Input, v3Input],
    };
  }

  throw new Error(`Unsupported sell routing for ${token.symbol}`);
}

// ---------- Top-level encoders ----------

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: '0';
  description: string;
}

export interface BasketBuyOptions {
  recipient: Address;
  deadline: bigint;
  slippageBps: number;
  // Per-token quotes (in BASKET order). Lengths must match.
  quotes: BasketQuote[];
  // Total USDC amount earmarked for the basket leg. Split equally across tokens.
  totalUsdc: bigint;
}

export function encodeBasketBuy(opts: BasketBuyOptions): { unsignedTx: UnsignedTx; perLegUsdc: bigint } {
  const { recipient, deadline, slippageBps, quotes, totalUsdc } = opts;
  if (quotes.length !== BASKET.length) {
    throw new Error(`expected ${BASKET.length} quotes, got ${quotes.length}`);
  }

  const perLegUsdc = totalUsdc / BigInt(BASKET.length);
  const dust = totalUsdc - perLegUsdc * BigInt(BASKET.length);

  const allCommands: number[] = [];
  const allInputs: Hex[] = [];
  let needsWethSweep = false;

  for (let i = 0; i < BASKET.length; i++) {
    const token = BASKET[i]!;
    const quote = quotes[i]!;
    if (quote.address.toLowerCase() !== token.address.toLowerCase()) {
      throw new Error(`quote/token mismatch at index ${i}`);
    }
    const usdcThisLeg = perLegUsdc + (i === 0 ? dust : 0n);
    const minOut = applySlippage(quote.amountOut, slippageBps);

    // For mixed V3->V4 (ROBOT): pull the V3 leg's intermediate output (WETH)
    // from the quote's hopOutputs and apply slippage. That becomes V3's
    // amountOutMin AND V4's amountIn. Any V3 over-delivery stays as residual
    // WETH and is swept at the end.
    let intermediateMin: bigint | undefined;
    const hops = token.hops!;
    const isMixed = hops.some((h) => h.version === 'v4') && hops.some((h) => h.version === 'v3');
    if (isMixed) {
      if (!quote.hopOutputs || quote.hopOutputs[0] === undefined || quote.hopOutputs[0] === 0n) {
        throw new Error(`${token.symbol}: missing intermediate hopOutput for mixed path`);
      }
      intermediateMin = applySlippage(quote.hopOutputs[0], slippageBps);
      needsWethSweep = true;
    }

    const leg = buildBuyLeg(token, usdcThisLeg, minOut, recipient, intermediateMin);
    allCommands.push(...leg.commands);
    allInputs.push(...leg.inputs);
  }

  // Trailing SWEEPs: USDC dust (rare — V3_SWAP_EXACT_IN consumes the full input)
  // and WETH residual from any V3-over-delivery on mixed legs (ROBOT).
  allCommands.push(CMD_SWEEP);
  allInputs.push(encodeSweep(USDC, recipient, 0n));
  if (needsWethSweep) {
    allCommands.push(CMD_SWEEP);
    allInputs.push(encodeSweep(WETH, recipient, 0n));
  }

  const data = encodeFunctionData({
    abi: UR_EXECUTE_ABI,
    functionName: 'execute',
    args: [commandsBytes(allCommands), allInputs, deadline],
  });

  return {
    unsignedTx: {
      to: UNIVERSAL_ROUTER,
      data,
      value: '0',
      description: `UR.execute(basket-buy, ${BASKET.length} legs, deadline=${deadline})`,
    },
    perLegUsdc,
  };
}

export interface BasketSellInput {
  token: BasketTokenConfig;
  amountIn: bigint;
  minUsdcOut: bigint; // post-slippage
}

export function encodeBasketSell(
  inputs: readonly BasketSellInput[],
  recipient: Address,
  deadline: bigint,
): UnsignedTx {
  const allCommands: number[] = [];
  const allInputs: Hex[] = [];

  for (const { token, amountIn, minUsdcOut } of inputs) {
    const leg = buildSellLeg(token, amountIn, minUsdcOut, recipient);
    allCommands.push(...leg.commands);
    allInputs.push(...leg.inputs);
  }

  // Trailing SWEEP refunds any leftover input-token dust to user.
  for (const { token } of inputs) {
    allCommands.push(CMD_SWEEP);
    allInputs.push(encodeSweep(token.address, recipient, 0n));
  }

  const data = encodeFunctionData({
    abi: UR_EXECUTE_ABI,
    functionName: 'execute',
    args: [commandsBytes(allCommands), allInputs, deadline],
  });

  return {
    to: UNIVERSAL_ROUTER,
    data,
    value: '0',
    description: `UR.execute(basket-sell, ${inputs.length} legs, deadline=${deadline})`,
  };
}

// ---------- Approval helpers ----------

// Direct ERC20 approval from owner to spender.
export function buildErc20Approve(token: Address, spender: Address, amount: bigint): UnsignedTx {
  return {
    to: token,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [spender, amount],
    }),
    value: '0',
    description: `${token}.approve(${spender}, ${amount.toString()})`,
  };
}

// Permit2.approve(token, spender, amount, expiration). Required so UR can pull
// `token` from the user's Permit2 allowance during V3_SWAP_EXACT_IN.
export function buildPermit2Approve(
  token: Address,
  spender: Address,
  amount: bigint,
  expiration: bigint,
): UnsignedTx {
  if (amount > (1n << 160n) - 1n) throw new Error('Permit2 amount exceeds uint160');
  if (expiration > (1n << 48n) - 1n) throw new Error('Permit2 expiration exceeds uint48');
  return {
    to: PERMIT2,
    data: encodeFunctionData({
      abi: PERMIT2_APPROVE_ABI,
      functionName: 'approve',
      args: [token, spender, amount, Number(expiration)],
    }),
    value: '0',
    description: `Permit2.approve(${token}, ${spender}, ${amount.toString()}, exp=${expiration})`,
  };
}

// Re-export concat for tests / callers
export { concat };
