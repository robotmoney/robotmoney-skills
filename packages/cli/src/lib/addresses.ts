import type { Address } from 'viem';

export type SupportedChain = 'base';

export const CHAIN_IDS: Record<SupportedChain, number> = {
  base: 8453,
};

export interface ChainAddresses {
  vault: Address;
  usdc: Address;
  morphoAdapter: Address;
  aaveAdapter: Address;
  compoundAdapter: Address;
  aavePool: Address;
  compoundComet: Address;
  morphoVault: Address;
}

// Gauntlet USDC Prime on Base — wrapped by the Robot Money MorphoAdapter at 0xa6ed...17e9.
// Immutable on the adapter. If a new MorphoAdapter is ever deployed, update this constant
// or read from the adapter via MORPHO_VAULT() instead.
export const MORPHO_GAUNTLET_USDC_PRIME_BASE: Address =
  '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61';

export const ADDRESSES: Record<SupportedChain, ChainAddresses> = {
  base: {
    vault: '0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    morphoAdapter: '0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9',
    aaveAdapter: '0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea',
    compoundAdapter: '0x8247da22a59fce074c102431048d0ce7294c2652',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    compoundComet: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
    morphoVault: MORPHO_GAUNTLET_USDC_PRIME_BASE,
  },
};
