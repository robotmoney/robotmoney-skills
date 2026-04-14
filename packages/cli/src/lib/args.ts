import { z } from 'zod';
import type { Address } from 'viem';
import { isAddress } from 'viem';

export const chainSchema = z.enum(['base']);

export const addressSchema = z
  .string()
  .refine((v): v is Address => isAddress(v), { message: 'Invalid EVM address' });

export const amountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Amount must be a decimal number like "100" or "100.50"');

export const sharesSchema = z.union([
  z.literal('max'),
  z.string().regex(/^\d+(\.\d+)?$/, 'Shares must be "max" or a decimal number'),
]);

export const globalFlagsSchema = z.object({
  chain: chainSchema,
  rpcUrl: z.string().url().optional(),
  pretty: z.boolean().optional(),
});

export type GlobalFlags = z.infer<typeof globalFlagsSchema>;
