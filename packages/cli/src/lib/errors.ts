import { BaseError, ContractFunctionRevertedError } from 'viem';

export const REVERT_GUIDE: Record<string, { cause: string; action: string }> = {
  TVLCapExceeded: {
    cause: 'Deposit would exceed the vault TVL cap.',
    action: 'Reduce amount or wait for the cap to be raised.',
  },
  PerDepositCapExceeded: {
    cause: 'Single deposit exceeds the per-deposit cap.',
    action: 'Split into multiple deposits under the cap.',
  },
  VaultShutdown: {
    cause: 'Vault is permanently shut down — deposits disabled.',
    action: 'Withdrawals still work; no new deposits accepted.',
  },
  EnforcedPause: {
    cause: 'Vault is paused (operational emergency).',
    action: 'Wait for unpause.',
  },
  NoActiveAdapters: {
    cause: 'No active yield adapters configured.',
    action: 'Operator attention required before deposits can route.',
  },
  ZeroAddress: {
    cause: 'Zero address passed where a non-zero address is required.',
    action: 'Provide a valid receiver/owner address.',
  },
};

export function extractRevert(err: unknown): { name: string | null; message: string } {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? null;
      return { name, message: revert.shortMessage };
    }
    return { name: null, message: err.shortMessage };
  }
  if (err instanceof Error) return { name: null, message: err.message };
  return { name: null, message: String(err) };
}
