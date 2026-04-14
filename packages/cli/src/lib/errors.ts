import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from 'viem';
import { VAULT_ABI } from './abi.js';

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
  ERC4626ExceededMaxDeposit: {
    cause: 'Deposit amount exceeds the vault\u2019s maximum for this receiver.',
    action: 'Reduce the amount; check TVL cap and per-deposit cap.',
  },
  ERC4626ExceededMaxMint: {
    cause: 'Share mint exceeds the vault\u2019s maximum for this receiver.',
    action: 'Reduce shares requested; check vault caps.',
  },
  ERC4626ExceededMaxWithdraw: {
    cause: 'Withdraw amount exceeds the owner\u2019s available balance.',
    action: 'Use `prepare-redeem --shares max` to exit the full position, or reduce the requested amount.',
  },
  ERC4626ExceededMaxRedeem: {
    cause: 'Redeem shares exceed the owner\u2019s current share balance.',
    action: 'Reduce shares, or use `--shares max` which reads balanceOf automatically.',
  },
  ERC20InsufficientBalance: {
    cause: 'Sender does not have enough tokens for this operation.',
    action: 'Fund the sender address before retrying.',
  },
  ERC20InsufficientAllowance: {
    cause: 'Token allowance is lower than the amount being spent.',
    action: 'Re-run with the approval tx included (default behavior of prepare-deposit), then broadcast approve before deposit.',
  },
};

function findRevertData(err: unknown): Hex | null {
  if (!(err instanceof BaseError)) return null;
  // Walk the cause chain looking for any object with a `data` field that is a 0x-prefixed hex string
  let cursor: unknown = err;
  const seen = new Set<unknown>();
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const rec = cursor as Record<string, unknown>;
    const data = rec.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      return data as Hex;
    }
    // nested data object (e.g. ContractFunctionRevertedError stores {errorName, args, abiItem} under .data)
    if (data && typeof data === 'object') {
      const inner = (data as Record<string, unknown>).data;
      if (typeof inner === 'string' && inner.startsWith('0x') && inner.length >= 10) {
        return inner as Hex;
      }
    }
    cursor = rec.cause;
  }
  return null;
}

export function extractRevert(err: unknown): { name: string | null; message: string } {
  if (err instanceof BaseError) {
    // First try viem's own decoding
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? null;
      if (name) return { name, message: revert.shortMessage };
    }

    // Fall back to manual decode against the vault ABI, since estimateGas
    // doesn't automatically run calldata through our ABI for custom errors.
    const revertData = findRevertData(err);
    if (revertData) {
      try {
        const decoded = decodeErrorResult({ abi: VAULT_ABI, data: revertData });
        // Legacy Solidity `Error(string)` carries the reason string as arg[0].
        // Prefer that over just the type name.
        if (decoded.errorName === 'Error' && Array.isArray(decoded.args) && typeof decoded.args[0] === 'string') {
          return {
            name: null,
            message: `Execution reverted: ${decoded.args[0]}`,
          };
        }
        return {
          name: decoded.errorName,
          message: `Execution reverted: ${decoded.errorName}`,
        };
      } catch {
        // Selector not in our ABI — return the raw selector for debuggability
        return {
          name: null,
          message: `Execution reverted (unrecognized selector ${revertData.slice(0, 10)})`,
        };
      }
    }

    return { name: null, message: err.shortMessage };
  }
  if (err instanceof Error) return { name: null, message: err.message };
  return { name: null, message: String(err) };
}
