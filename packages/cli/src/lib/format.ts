import { formatUnits, parseUnits } from 'viem';

export const USDC_DECIMALS = 6;
export const RM_USDC_DECIMALS = 6;

export function formatUsdc(raw: bigint): string {
  return formatUnits(raw, USDC_DECIMALS);
}

export function parseUsdc(value: string): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

export function formatShares(raw: bigint): string {
  return formatUnits(raw, RM_USDC_DECIMALS);
}

export function parseShares(value: string): bigint {
  return parseUnits(value, RM_USDC_DECIMALS);
}

export function formatPct(rate: number, places = 2): string {
  return `${(rate * 100).toFixed(places)}%`;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export interface OutputOptions {
  pretty: boolean;
}

export function emitJson(data: unknown, opts: OutputOptions = { pretty: false }): void {
  const indent = opts.pretty ? 2 : 0;
  process.stdout.write(JSON.stringify(data, jsonReplacer, indent) + '\n');
}

export function emitError(err: { code: string; error: string; details?: unknown }): void {
  process.stderr.write(JSON.stringify(err, jsonReplacer) + '\n');
}
