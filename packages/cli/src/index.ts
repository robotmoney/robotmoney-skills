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

  attachGlobalFlags(program.command('prepare-deposit'))
    .description('Prepare an unsigned deposit transaction (with auto-included USDC approval)')
    .requiredOption('--user-address <address>', 'EVM address of the depositor')
    .requiredOption('--amount <usdc>', 'USDC amount to deposit (decimal)')
    .requiredOption('--receiver <address>', 'EVM address receiving rmUSDC shares')
    .option('--skip-approve', 'omit the approval transaction from the output')
    .action(
      async (
        opts: RawGlobalOpts & {
          userAddress: string;
          amount: string;
          receiver: string;
          skipApprove?: boolean;
        },
      ) =>
        runOrDie(() =>
          prepareDeposit(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            amount: amountSchema.parse(opts.amount),
            receiver: addressSchema.parse(opts.receiver),
            skipApprove: opts.skipApprove ?? false,
          }),
        ),
    );

  attachGlobalFlags(program.command('prepare-redeem'))
    .description('Prepare an unsigned redeem transaction (one-tx synchronous withdrawal)')
    .requiredOption('--user-address <address>', 'EVM address of the owner')
    .requiredOption('--shares <amount>', 'shares to redeem, or "max"')
    .requiredOption('--receiver <address>', 'EVM address receiving USDC')
    .action(
      async (
        opts: RawGlobalOpts & { userAddress: string; shares: string; receiver: string },
      ) =>
        runOrDie(() =>
          prepareRedeem(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            shares: sharesSchema.parse(opts.shares),
            receiver: addressSchema.parse(opts.receiver),
          }),
        ),
    );

  attachGlobalFlags(program.command('prepare-withdraw'))
    .description('Prepare an unsigned withdrawal by target net USDC amount')
    .requiredOption('--user-address <address>', 'EVM address of the owner')
    .requiredOption('--amount <usdc>', 'net USDC amount to receive (decimal)')
    .requiredOption('--receiver <address>', 'EVM address receiving USDC')
    .action(
      async (
        opts: RawGlobalOpts & { userAddress: string; amount: string; receiver: string },
      ) =>
        runOrDie(() =>
          prepareWithdraw(parseGlobal(opts), {
            userAddress: addressSchema.parse(opts.userAddress),
            amount: amountSchema.parse(opts.amount),
            receiver: addressSchema.parse(opts.receiver),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-deposit'))
    .description('Sign and broadcast a deposit end-to-end via an OWS wallet')
    .requiredOption('--amount <usdc>', 'USDC amount to deposit (decimal)')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive rmUSDC (defaults to the wallet address)')
    .action(
      async (
        opts: RawGlobalOpts & {
          amount: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
        },
      ) =>
        runOrDie(() =>
          executeDeposit(parseGlobal(opts), {
            amount: amountSchema.parse(opts.amount),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-redeem'))
    .description('Sign and broadcast a redeem end-to-end via an OWS wallet')
    .requiredOption('--shares <amount>', 'shares to redeem, or "max"')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive USDC (defaults to the wallet address)')
    .action(
      async (
        opts: RawGlobalOpts & {
          shares: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
        },
      ) =>
        runOrDie(() =>
          executeRedeem(parseGlobal(opts), {
            shares: sharesSchema.parse(opts.shares),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
          }),
        ),
    );

  attachGlobalFlags(program.command('execute-withdraw'))
    .description('Sign and broadcast a withdrawal end-to-end via an OWS wallet')
    .requiredOption('--amount <usdc>', 'net USDC amount to receive (decimal)')
    .option('--wallet <name>', 'OWS wallet name (optional if only one wallet exists locally)')
    .option('--passphrase <string>', 'OWS passphrase (or set OWS_PASSPHRASE env)')
    .option('--storage-path <dir>', 'override the OWS vault directory')
    .option('--receiver <address>', 'EVM address to receive USDC (defaults to the wallet address)')
    .action(
      async (
        opts: RawGlobalOpts & {
          amount: string;
          wallet?: string;
          passphrase?: string;
          storagePath?: string;
          receiver?: string;
        },
      ) =>
        runOrDie(() =>
          executeWithdraw(parseGlobal(opts), {
            amount: amountSchema.parse(opts.amount),
            ...(opts.wallet !== undefined ? { wallet: opts.wallet } : {}),
            ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
            ...(opts.storagePath !== undefined ? { storagePath: opts.storagePath } : {}),
            ...(opts.receiver !== undefined ? { receiver: addressSchema.parse(opts.receiver) } : {}),
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
