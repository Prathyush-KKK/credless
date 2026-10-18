// Build of the publishable package (plan §3): one ESM bundle per export, declarations on. Task 8 wires it into the
// release; nothing else edits the entries here, because the exports map in package.json mirrors them.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config/index.ts',
    adapters: 'src/adapters/index.ts',
    server: 'src/server/index.ts',
    reporter: 'src/reporter/index.ts',
    cli: 'src/cli.ts',
    // Loaded by path, never through the cli bundle: a consumer's Playwright config names the global setup, and `run`
    // gives the workers the shim with `--import` (spawn.ts finds it beside cli.js).
    'global-setup': 'src/runner/global-setup.ts',
    'worker-shim': 'src/runner/worker-shim.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outDir: 'dist',
  // `.js` and `.d.ts` (the package is ESM-only), as the exports map and the bin entry name them.
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: false,
  // Peers and optional natives stay external; the kit never bundles Playwright. `typescript` is a devDependency
  // `check-tests` imports dynamically when the project has one (it falls back to its regex engine otherwise): 8 MB
  // that must never end up in the bundle.
  deps: {
    neverBundle: [
      /^@playwright\//,
      'playwright-core',
      'playwright',
      '@napi-rs/keyring',
      'playwright-ctrf-json-reporter',
      '@axe-core/playwright',
      'typescript',
    ],
  },
});
