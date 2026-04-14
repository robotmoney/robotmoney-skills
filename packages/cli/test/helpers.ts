import { vi } from 'vitest';
import type { PublicClient } from 'viem';

export interface MockReadHandler {
  (args: { functionName: string; args?: readonly unknown[]; address?: string }): unknown;
}

export function makeMockClient(handler: MockReadHandler): PublicClient {
  const client: Partial<PublicClient> = {
    readContract: vi.fn(async (params: unknown) => {
      const p = params as { functionName: string; args?: readonly unknown[]; address?: string };
      return handler({ functionName: p.functionName, args: p.args, address: p.address });
    }) as PublicClient['readContract'],
    getBlockNumber: vi.fn(async () => 18234567n) as PublicClient['getBlockNumber'],
    estimateGas: vi.fn(async () => 200000n) as PublicClient['estimateGas'],
  };
  return client as PublicClient;
}

export function captureStdout(): { restore: () => void; chunks: string[] } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error - overwriting for capture
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = original;
    },
    chunks,
  };
}

export function captureStderr(): { restore: () => void; chunks: string[] } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // @ts-expect-error - overwriting for capture
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    restore: () => {
      process.stderr.write = original;
    },
    chunks,
  };
}
