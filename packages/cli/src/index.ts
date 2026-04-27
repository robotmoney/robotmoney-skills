import { Command } from 'commander';
import { addressSchema, amountSchema, chainSchema, sharesSchema } from './lib/args.js';
import { emitError } from './lib/format.js';
import { healthCheck } from './commands/health-check.js';
import { getVault } from './commands/get-vault.js';
import { getBalance } from './commands/get-balance.js';
import { getApy } from './commands/get-apy.js';
import { prepareDeposit } from './commands/prepare-deposit.js';
import { prepareRedeem } from './commands/prepare-redeem.js';
import { prepareWithdraw } from './commands/prepare-withdraw.js';
import { executeDeposit } from './commands/execute-deposit.js';
import { executeRedeem } from './commands/execute-redeem.js';
import { executeWithdraw } from './commands/execute-withdraw.js';
import { createWallet } from './commands/create-wallet.js';
import { getBasketHoldings } from './commands/get-basket-holdings.js';

interface RawGlobalOpts {
  chain?: string;
  rpcUrl?: string;
  pretty?: boolean;
}

function parseGlobal(opts: RawGlobalOpts): { chain: 'base'; rpcUrl?: string; pretty?: boolean } {
  const chain = chainSchema.parse(opts.chain);
  const out: { chain: 'base'; rpcUrl?: string; pretty?: boolean } = { chain };
  if (opts.rpcUrl !== undefined) out.rpcUrl = opts.rpcUrl;
  if (opts.pretty !== undefined) out.pretty = opts.pretty;
  return out;
}

function attachGlobalFlags(cmd: Command): Command {
  return cmd
    .requiredOption('--chain <name>', 'target chain (base)')
    .option('--rpc-url <url>', 'override RPC URL')
    .option('--pretty', 'pretty-print JSON output');
}

async function runOrDie(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError({ code: 'COMMAND_FAILED', error: message });
    process.exit(1);
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('robotmoney')
    .description('CLI for the Robot Money stablecoin yield vault on Base')
    .version('0.1.0');

  attachGlobalFlags(program.command('health-check'))
    .description('Check RPC connectivity and vault reachability')
    .action(async (opts: RawGlobalOpts) => runOrDie(() => healthCheck(parseGlobal(opts))));

  attachGlobalFlags(program.command('get-vault'))
    .description('Get full vault state: caps, fees, share price, totals')
    .option('--verbose', 'include per-adapter breakdown')
    .action(async (opts: RawGlobalOpts & { verbose?: boolean }) =>
      runOrDie(() => getVault(parseGlobal(opts), { verbose: opts.verbose ?? false })),
    );

  attachGlobalFlags(program.command('get-balance'))
    .description('Get a user rmUSDC balance and USDC-equivalent value')
    .requiredOption('--user-address <address>', 'EVM address of the user')
    .action(async (opts: RawGlobalOpts & { userAddress: string }) =>
      runOrDie(() => getBalance(parseGlobal(opts), addressSchema.parse(opts.userAddress))),
    );

  attachGlobalFlags(program.command('get-apy'))
    .description('Get blended APY across Morpho, Aave, and Compound')
    .action(async (opts: RawGlobalOpts) => runOrDie(() => getApy(parseGlobal(opts))));

  attachGlobalFlags(program.command('get-basket-holdings'))
    .description('Get the user\'s balances of the 6 basket tokens with USDC valuation')
    .requiredOption('--user-address <address>', 'EVM address of the holder')
    .option('--no-pricing', 'skip USD valuation (faster, no quoter calls)')
    .action(
      async (opts: RawGlobalOpts & { userAddress: string; pricing?: boolean }) =>
        runOrDie(() =>
          getBasketHoldings(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            noPricing: opts.pricing === false,
          }),
        ),
    );

  attachGlobalFlags(program.command('prepare-deposit'))
    .description(
      'Prepare unsigned deposit txs: 95% to vault + 5% across a 6-token agent basket (USDC approval included)',
    )
    .requiredOption('--user-address <address>', 'EVM address of the depositor')
    .requiredOption('--amount <usdc>', 'USDC amount to deposit (decimal)')
    .requiredOption('--receiver <address>', 'EVM address receiving rmUSDC shares + basket tokens')
    .option('--skip-approve', 'omit the vault approval transaction from the output')
    .option('--no-basket', 'vault-only mode: skip the 5% basket leg')
    .option('--basket-only', 'basket-only mode: skip the vault leg, swap full amount to basket')
    .option('--slippage-bps <bps>', 'slippage tolerance for basket swaps in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          userAddress: string;
          amount: string;
          receiver: string;
          skipApprove?: boolean;
          basket?: boolean; // commander negation: --no-basket flips this to false
          basketOnly?: boolean;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          prepareDeposit(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            amount: amountSchema.parse(opts.amount),
            receiver: addressSchema.parse(opts.receiver),
            skipApprove: opts.skipApprove ?? false,
            noBasket: opts.basket === false,
            basketOnly: opts.basketOnly ?? false,
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('prepare-redeem'))
    .description(
      'Prepare unsigned redeem txs: vault redeem + optional basket sells (--sell-all/--sell-percent/--sell-tokens)',
    )
    .requiredOption('--user-address <address>', 'EVM address of the owner')
    .requiredOption('--shares <amount>', 'rmUSDC shares to redeem; "max", a decimal, or "0" to skip vault leg')
    .requiredOption('--receiver <address>', 'EVM address receiving USDC + any sold basket tokens')
    .option('--sell-all', 'sell 100% of every basket token the user holds')
    .option('--sell-percent <bps>', 'sell N% of every basket token the user holds (1-100)')
    .option('--sell-tokens <symbols>', 'comma-separated symbols to sell (VIRTUAL,JUNO,...)')
    .option('--sell-amounts <decimals>', 'comma-separated decimal amounts paired with --sell-tokens')
    .option('--slippage-bps <bps>', 'slippage tolerance for basket sells in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          userAddress: string;
          shares: string;
          receiver: string;
          sellAll?: boolean;
          sellPercent?: string;
          sellTokens?: string;
          sellAmounts?: string;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          prepareRedeem(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            shares: sharesSchema.parse(opts.shares),
            receiver: addressSchema.parse(opts.receiver),
            ...(opts.sellAll !== undefined ? { sellAll: opts.sellAll } : {}),
            ...(opts.sellPercent !== undefined
              ? { sellPercent: Number.parseInt(opts.sellPercent, 10) }
              : {}),
            ...(opts.sellTokens !== undefined
              ? { sellTokens: opts.sellTokens.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.sellAmounts !== undefined
              ? { sellAmounts: opts.sellAmounts.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('prepare-withdraw'))
    .description(
      'Prepare unsigned withdraw txs: vault withdraw by exact USDC amount + optional basket sells',
    )
    .requiredOption('--user-address <address>', 'EVM address of the owner')
    .requiredOption('--amount <usdc>', 'net USDC amount to receive (decimal); "0" skips vault leg')
    .requiredOption('--receiver <address>', 'EVM address receiving USDC')
    .option('--sell-all', 'sell 100% of every basket token the user holds')
    .option('--sell-percent <bps>', 'sell N% of every basket token the user holds (1-100)')
    .option('--sell-tokens <symbols>', 'comma-separated symbols to sell (VIRTUAL,JUNO,...)')
    .option('--sell-amounts <decimals>', 'comma-separated decimal amounts paired with --sell-tokens')
    .option('--slippage-bps <bps>', 'slippage tolerance for basket sells in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          userAddress: string;
          amount: string;
          receiver: string;
          sellAll?: boolean;
          sellPercent?: string;
          sellTokens?: string;
          sellAmounts?: string;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          prepareWithdraw(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            amount: amountSchema.parse(opts.amount),
            receiver: addressSchema.parse(opts.receiver),
            ...(opts.sellAll !== undefined ? { sellAll: opts.sellAll } : {}),
            ...(opts.sellPercent !== undefined
              ? { sellPercent: Number.parseInt(opts.sellPercent, 10) }
              : {}),
            ...(opts.sellTokens !== undefined
              ? { sellTokens: opts.sellTokens.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.sellAmounts !== undefined
              ? { sellAmounts: opts.sellAmounts.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-deposit'))
    .description('Sign and broadcast a deposit (95% vault + 5% basket) end-to-end via an OWS wallet')
    .requiredOption('--amount <usdc>', 'USDC amount to deposit (decimal)')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive rmUSDC + basket tokens (defaults to wallet address)')
    .option('--no-basket', 'vault-only mode: skip the 5% basket leg')
    .option('--basket-only', 'basket-only mode: skip the vault leg')
    .option('--slippage-bps <bps>', 'basket slippage tolerance in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          amount: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
          basket?: boolean;
          basketOnly?: boolean;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          executeDeposit(parseGlobal(opts), {
            amount: amountSchema.parse(opts.amount),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
            noBasket: opts.basket === false,
            basketOnly: opts.basketOnly ?? false,
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-redeem'))
    .description('Sign and broadcast a redeem (vault + optional basket sells) end-to-end via OWS')
    .requiredOption('--shares <amount>', 'rmUSDC shares to redeem; "max", a decimal, or "0" to skip vault leg')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive USDC (defaults to the wallet address)')
    .option('--sell-all', 'sell 100% of every basket token the wallet holds')
    .option('--sell-percent <bps>', 'sell N% of every basket token the wallet holds (1-100)')
    .option('--sell-tokens <symbols>', 'comma-separated symbols to sell (VIRTUAL,JUNO,...)')
    .option('--sell-amounts <decimals>', 'comma-separated decimal amounts paired with --sell-tokens')
    .option('--slippage-bps <bps>', 'basket slippage tolerance in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          shares: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
          sellAll?: boolean;
          sellPercent?: string;
          sellTokens?: string;
          sellAmounts?: string;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          executeRedeem(parseGlobal(opts), {
            shares: sharesSchema.parse(opts.shares),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
            ...(opts.sellAll !== undefined ? { sellAll: opts.sellAll } : {}),
            ...(opts.sellPercent !== undefined
              ? { sellPercent: Number.parseInt(opts.sellPercent, 10) }
              : {}),
            ...(opts.sellTokens !== undefined
              ? { sellTokens: opts.sellTokens.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.sellAmounts !== undefined
              ? { sellAmounts: opts.sellAmounts.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-withdraw'))
    .description('Sign and broadcast a withdraw (vault + optional basket sells) end-to-end via OWS')
    .requiredOption('--amount <usdc>', 'net USDC amount to receive (decimal); "0" skips vault leg')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive USDC (defaults to the wallet address)')
    .option('--sell-all', 'sell 100% of every basket token the wallet holds')
    .option('--sell-percent <bps>', 'sell N% of every basket token the wallet holds (1-100)')
    .option('--sell-tokens <symbols>', 'comma-separated symbols to sell (VIRTUAL,JUNO,...)')
    .option('--sell-amounts <decimals>', 'comma-separated decimal amounts paired with --sell-tokens')
    .option('--slippage-bps <bps>', 'basket slippage tolerance in bps (default 300 = 3%)')
    .action(
      async (
        opts: RawGlobalOpts & {
          amount: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
          sellAll?: boolean;
          sellPercent?: string;
          sellTokens?: string;
          sellAmounts?: string;
          slippageBps?: string;
        },
      ) =>
        runOrDie(() =>
          executeWithdraw(parseGlobal(opts), {
            amount: amountSchema.parse(opts.amount),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
            ...(opts.sellAll !== undefined ? { sellAll: opts.sellAll } : {}),
            ...(opts.sellPercent !== undefined
              ? { sellPercent: Number.parseInt(opts.sellPercent, 10) }
              : {}),
            ...(opts.sellTokens !== undefined
              ? { sellTokens: opts.sellTokens.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.sellAmounts !== undefined
              ? { sellAmounts: opts.sellAmounts.split(',').map((s) => s.trim()) }
              : {}),
            ...(opts.slippageBps !== undefined
              ? { slippageBps: Number.parseInt(opts.slippageBps, 10) }
              : {}),
          }),
        ),
    );

  program
    .command('create-wallet')
    .description('Create a new Open Wallet Standard (OWS) wallet for an agent or machine')
    .option('--label <string>', 'human-friendly label for the wallet')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--passphrase <string>', 'passphrase to encrypt the keystore (prompted if omitted)')
    .option('--pretty', 'pretty-print JSON output')
    .action(
      async (opts: {
        label?: string;
        storagePath?: string;
        passphrase?: string;
        pretty?: boolean;
      }) =>
        runOrDie(() =>
          createWallet({
            ...(opts.label !== undefined ? { label: opts.label } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.pretty !== undefined ? { pretty: opts.pretty } : {}),
          }),
        ),
    );

  return program;
}

const program = buildProgram();
program.parseAsync(process.argv).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  emitError({ code: 'UNCAUGHT', error: message });
  process.exit(1);
});
