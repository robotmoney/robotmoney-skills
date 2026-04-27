#!/usr/bin/env tsx
/**
 * End-to-end fork test against a local anvil instance forked from Base mainnet.
 *
 * Verifies the full basket flow without spending real money:
 *   1. Start anvil --fork-url https://mainnet.base.org
 *   2. Fund a test wallet with ETH (anvil_setBalance) and USDC (impersonate a whale)
 *   3. Run prepare-deposit's tx sequence end-to-end (vault leg + basket buy)
 *   4. Verify rmUSDC shares + 6 basket token balances all increased
 *   5. Run prepare-redeem's --sell-all sequence
 *   6. Verify USDC came back, basket balances dropped
 *
 * Run: pnpm --filter @robotmoney/cli exec tsx ../../scripts/fork-test.ts
 *
 * Requires: anvil (foundry). Not part of CI — run locally before publishing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ADDRESSES } from '../packages/cli/src/lib/addresses.js';
import { USDC_ABI, VAULT_ABI } from '../packages/cli/src/lib/abi.js';
import { BASKET, USDC } from '../packages/cli/src/lib/basket/constants.js';
import {
  buildBasketBuyLeg,
  buildBasketSellLeg,
} from '../packages/cli/src/lib/basket/leg-builders.js';

// ---------- Config ----------

const ANVIL_PORT = 18545;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
// Anvil's first deterministic test account (mnemonic: "test test test test ... junk")
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

// Compound III Comet (cUSDCv3) on Base — major USDC holder.
const USDC_WHALE: Address = '0xb125E6687d4313864e53df431d5425969c15Eb2F';

const FUND_ETH = parseUnits('10', 18); // 10 ETH for gas
const FUND_USDC = parseUnits('100', 6); // 100 USDC to deposit

// ---------- Helpers ----------

function color(s: string, n: number): string {
  return `\x1b[${n}m${s}\x1b[0m`;
}
const green = (s: string) => color(s, 32);
const red = (s: string) => color(s, 31);
const yellow = (s: string) => color(s, 33);
const dim = (s: string) => color(s, 90);

async function startAnvil(): Promise<ChildProcess> {
  console.log(dim('Starting anvil --fork-url https://mainnet.base.org ...'));
  const proc = spawn(
    'anvil',
    [
      '--fork-url',
      'https://base-rpc.publicnode.com',
      '--port',
      String(ANVIL_PORT),
      '--chain-id',
      '8453',
      '--no-rate-limit',
      '--retries',
      '30',
      '--timeout',
      '30000',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr?.on('data', (data) => {
    const s = data.toString();
    if (s.trim() && !s.includes('Listening on')) {
      process.stderr.write(dim(`anvil: ${s}`));
    }
  });

  // Poll for readiness via JSON-RPC eth_chainId
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ANVIL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      });
      const json = (await res.json()) as { result?: string };
      if (json.result === '0x2105') return proc;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('anvil failed to start within 30s');
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
  return json.result;
}

async function setBalance(addr: Address, wei: bigint): Promise<void> {
  await rpcCall('anvil_setBalance', [addr, `0x${wei.toString(16)}`]);
}

async function impersonate(addr: Address): Promise<void> {
  await rpcCall('anvil_impersonateAccount', [addr]);
}

async function stopImpersonate(addr: Address): Promise<void> {
  await rpcCall('anvil_stopImpersonatingAccount', [addr]);
}

// ---------- Main flow ----------

async function main() {
  const anvil = await startAnvil();
  let exitCode = 0;
  try {
    const publicClient = createPublicClient({ chain: base, transport: http(ANVIL_URL) });
    const account = privateKeyToAccount(TEST_PK);
    const walletClient = createWalletClient({ account, chain: base, transport: http(ANVIL_URL) });

    const addrs = ADDRESSES.base;

    console.log('\n' + green('━━ Funding test wallet ━━'));
    await setBalance(TEST_ADDR, FUND_ETH);
    console.log(`  ETH:  ${formatUnits(FUND_ETH, 18)} ETH -> ${TEST_ADDR}`);

    // Fund USDC by impersonating Comet and transferring.
    await setBalance(USDC_WHALE, FUND_ETH); // give the whale some ETH for gas
    await impersonate(USDC_WHALE);
    const transferData = encodeFunctionData({
      abi: USDC_ABI,
      functionName: 'approve', // dummy fallback; we use sendTransaction directly below
      args: [TEST_ADDR, 0n],
    });
    void transferData;
    // Direct ERC20.transfer:
    const transferCallData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      functionName: 'transfer',
      args: [TEST_ADDR, FUND_USDC],
    });
    await rpcCall('eth_sendTransaction', [
      {
        from: USDC_WHALE,
        to: addrs.usdc,
        data: transferCallData,
        gas: '0x' + (200_000).toString(16),
      },
    ]);
    await stopImpersonate(USDC_WHALE);

    const usdcBefore = (await publicClient.readContract({
      address: addrs.usdc,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [TEST_ADDR],
    })) as bigint;
    console.log(`  USDC: ${formatUnits(usdcBefore, 6)} USDC -> ${TEST_ADDR}`);
    if (usdcBefore < FUND_USDC) throw new Error(`USDC fund failed (have ${usdcBefore})`);

    // ---------- Build deposit txs (95 vault + 5 basket) ----------
    console.log('\n' + green('━━ Building deposit (95% vault + 5% basket) ━━'));
    const VAULT_BPS = 9500n;
    const BPS = 10_000n;
    const vaultAmount = (FUND_USDC * VAULT_BPS) / BPS;
    const basketAmount = FUND_USDC - vaultAmount;
    console.log(`  vault leg:  ${formatUnits(vaultAmount, 6)} USDC`);
    console.log(`  basket leg: ${formatUnits(basketAmount, 6)} USDC`);

    const txs: Array<{ to: Address; data: Hex; value: bigint; description: string }> = [];

    // Vault leg: approve + deposit
    txs.push({
      to: addrs.usdc,
      data: encodeFunctionData({
        abi: USDC_ABI,
        functionName: 'approve',
        args: [addrs.vault, vaultAmount],
      }),
      value: 0n,
      description: `USDC.approve(vault, ${vaultAmount})`,
    });
    txs.push({
      to: addrs.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [vaultAmount, TEST_ADDR],
      }),
      value: 0n,
      description: `vault.deposit(${vaultAmount})`,
    });

    // Basket leg via shared helper (this is what the CLI itself uses)
    const buyLeg = await buildBasketBuyLeg(publicClient, {
      usdc: USDC,
      user: TEST_ADDR,
      recipient: TEST_ADDR,
      basketAmountRaw: basketAmount,
      slippageBps: 300,
    });
    for (const tx of buyLeg.transactions) {
      txs.push({
        to: tx.to,
        data: tx.data,
        value: 0n,
        description: tx.description ?? '',
      });
    }

    console.log(`  ${txs.length} txs total\n`);
    console.log(green('━━ Broadcasting deposit sequence ━━'));
    for (const [i, tx] of txs.entries()) {
      // Try eth_call first to surface the inner revert reason cleanly.
      try {
        await publicClient.call({
          account: TEST_ADDR,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        });
      } catch (callErr) {
        if (i === txs.length - 1) {
          // Final tx — eth_call gives us the cleanest error to inspect
          console.log(red(`  eth_call preview of tx ${i + 1} reverted:`));
          console.log(dim((callErr as Error).message.split('\n').slice(0, 8).join('\n')));
        }
      }
      const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chain: null,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const ok = receipt.status === 'success';
      console.log(
        `  [${i + 1}/${txs.length}] ${ok ? green('OK ') : red('FAIL')} ${tx.description}` +
          dim(`  gas=${receipt.gasUsed}  hash=${hash.slice(0, 10)}...`),
      );
      if (!ok) {
        console.error(red(`Deposit broadcast failed at tx ${i + 1}: ${tx.description}`));
        throw new Error(`tx ${i + 1} reverted`);
      }
      // After Permit2.approve (tx 4) confirms, double-check storage was written.
      if (tx.description.startsWith('Permit2.approve')) {
        const allowanceData = await publicClient.readContract({
          address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          abi: [
            {
              type: 'function',
              name: 'allowance',
              stateMutability: 'view',
              inputs: [
                { name: 'owner', type: 'address' },
                { name: 'token', type: 'address' },
                { name: 'spender', type: 'address' },
              ],
              outputs: [
                { name: 'amount', type: 'uint160' },
                { name: 'expiration', type: 'uint48' },
                { name: 'nonce', type: 'uint48' },
              ],
            },
          ],
          functionName: 'allowance',
          args: [TEST_ADDR, addrs.usdc, '0x6fF5693b99212Da76ad316178A184AB56D299b43'],
        });
        console.log(
          dim(
            `       Permit2 allowance(USER, USDC, UR) = (amount=${allowanceData[0]}, exp=${allowanceData[1]}, nonce=${allowanceData[2]})`,
          ),
        );
      }
    }

    // ---------- Verify post-deposit ----------
    console.log('\n' + green('━━ Verifying deposit results ━━'));
    const sharesAfter = (await publicClient.readContract({
      address: addrs.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [TEST_ADDR],
    })) as bigint;
    console.log(`  rmUSDC shares: ${formatUnits(sharesAfter, 6)}`);
    if (sharesAfter === 0n) throw new Error('No rmUSDC minted');

    const usdcAfterDeposit = (await publicClient.readContract({
      address: addrs.usdc,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [TEST_ADDR],
    })) as bigint;
    console.log(`  USDC remaining: ${formatUnits(usdcAfterDeposit, 6)}`);

    const basketBalances: Record<string, bigint> = {};
    for (const token of BASKET) {
      const bal = (await publicClient.readContract({
        address: token.address,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [TEST_ADDR],
      })) as bigint;
      basketBalances[token.symbol] = bal;
      const status = bal > 0n ? green('OK') : red('ZERO');
      console.log(
        `  ${status} ${token.symbol.padEnd(8)} balance=${formatUnits(bal, token.decimals)}`,
      );
    }

    const allBasketReceived = Object.values(basketBalances).every((b) => b > 0n);
    if (!allBasketReceived) {
      console.error(red('FAIL: some basket tokens never landed in the wallet'));
      throw new Error('basket buy did not fill all 6 legs');
    }

    // ---------- Build sell txs ----------
    console.log('\n' + green('━━ Building basket sell (--sell-all) ━━'));
    const sellLeg = await buildBasketSellLeg(publicClient, {
      user: TEST_ADDR,
      recipient: TEST_ADDR,
      sellAll: true,
      slippageBps: 300,
    });
    if (sellLeg.transactions.length === 0) {
      throw new Error('sell leg produced no transactions');
    }
    console.log(
      `  ${sellLeg.transactions.length} txs total (${sellLeg.details?.sells.length ?? 0} sell legs)\n`,
    );
    console.log(green('━━ Broadcasting sell sequence ━━'));
    for (const [i, tx] of sellLeg.transactions.entries()) {
      const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: 0n,
        chain: null,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const ok = receipt.status === 'success';
      console.log(
        `  [${i + 1}/${sellLeg.transactions.length}] ${ok ? green('OK ') : red('FAIL')} ${tx.description}` +
          dim(`  gas=${receipt.gasUsed}`),
      );
      if (!ok) {
        console.error(red(`Sell broadcast failed at tx ${i + 1}: ${tx.description}`));
        throw new Error(`sell tx ${i + 1} reverted`);
      }
    }

    // ---------- Verify post-sell ----------
    console.log('\n' + green('━━ Verifying sell results ━━'));
    const usdcAfterSell = (await publicClient.readContract({
      address: addrs.usdc,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [TEST_ADDR],
    })) as bigint;
    const usdcGained = usdcAfterSell - usdcAfterDeposit;
    console.log(
      `  USDC after sell: ${formatUnits(usdcAfterSell, 6)} (gained ${formatUnits(usdcGained, 6)} from sells)`,
    );
    if (usdcGained <= 0n) throw new Error('Sells did not produce USDC');

    for (const token of BASKET) {
      const bal = (await publicClient.readContract({
        address: token.address,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [TEST_ADDR],
      })) as bigint;
      const expected = basketBalances[token.symbol]!;
      const dropped = expected - bal;
      const status = dropped >= (expected * 99n) / 100n ? green('OK') : yellow('PARTIAL');
      console.log(
        `  ${status} ${token.symbol.padEnd(8)} sold=${formatUnits(dropped, token.decimals)} remaining=${formatUnits(bal, token.decimals)}`,
      );
    }

    console.log('\n' + green('━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(green('  ALL FORK CHECKS PASSED'));
    console.log(green('━━━━━━━━━━━━━━━━━━━━━━━━━'));
  } catch (err) {
    console.error('\n' + red('FORK TEST FAILED:'));
    console.error(err);
    exitCode = 1;
  } finally {
    anvil.kill('SIGTERM');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
