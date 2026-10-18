// The quickstart suite's Playwright config: the kit's defaults (the reporters into the evidence folder, the global
// setup that takes the key over and starts the broker, no retries) plus one desktop project. `credless demo` starts
// the demo app itself and hands this run its origins (DEMO_WEB, DEMO_API) and its key file.
// workspace-only:start
// In the workspace a bare `npx playwright test` in this directory (or the dogfood `credless run --target demo`) starts
// the demo as Playwright's webServer instead, the way the kit's own self-tests do. The package's copy of this file
// (packages/kit/demo/, written by scripts/build-demo.ts) leaves the marked lines out: there `credless demo` always
// starts the server.
// workspace-only:end
//
// `credless demo --plant-secret` sets DEMO_PLANT_SECRET, and only then does the plant-secret spec run: as its own
// project, first, because it reads the runner's sign-in password file without deleting it and S1 deletes it.
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type Project } from '@playwright/test';
import { kitPlaywrightConfig } from 'credless/config';
// workspace-only:start
import { standaloneDemo } from '../../../packages/kit/test/helpers/demo-server.ts';

// workspace-only:end

const here = fileURLToPath(new URL('.', import.meta.url));
// as `evidence.reportsDir` in credless.config.ts: apps/demo/reports in the workspace (`credless demo` from the package
// keeps the evidence under the working directory instead)
const kit = kitPlaywrightConfig({ rootDir: here, reportsDir: '../reports', target: 'demo' });
const desktop = { ...devices['Desktop Chrome'] };
const PLANT = /plant-secret\.spec\.m?ts$/; // .mts in the package copy (scripts/build-demo.ts)
const projects: Project[] = process.env.DEMO_PLANT_SECRET
  ? [
      { name: 'plant-secret', testMatch: PLANT, use: desktop },
      { name: 'demo-e2e', testIgnore: PLANT, dependencies: ['plant-secret'], use: desktop },
    ]
  : [{ name: 'demo-e2e', testIgnore: PLANT, use: desktop }];

export default defineConfig({
  ...kit.config,
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { ...kit.config.use, actionTimeout: 15_000, navigationTimeout: 30_000 },
  // workspace-only:start
  ...standaloneDemo({ runId: kit.runId, src: fileURLToPath(new URL('../src/', import.meta.url)) }),
  // workspace-only:end
  projects,
});
