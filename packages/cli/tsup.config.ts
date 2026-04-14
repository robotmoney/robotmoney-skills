import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  shims: false,
  // OWS ships platform-specific native bindings we load dynamically at runtime.
  // Keep everything external so the bundler doesn't try to resolve the .node files.
  external: ['@open-wallet-standard/core', 'commander', 'viem', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
});
