// The kit's own Playwright config. Project `selftest` (default) runs the broker, guard, persona, evidence, runner and
// shim self-tests under test/selftest against the demo app; `demo-e2e` runs the quickstart suite in apps/demo/e2e
// against the same demo. The demo starts as Playwright's webServer and prints `ready web=... api=...`; the wait regex
// puts the two origins into the environment and the demo writes its stand-in runner key to a fresh 0600 file that
// credless.config.ts reads (docs/conventions.md §10). Started by `credless run --target selftest`, the CLI supplies
// the run id and the evidence folder; started bare (`npx playwright test`), the kit's defaults do.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { kitPlaywrightConfig } from './src/runner/playwright-config.ts';
import { ENV } from './src/types.ts';
import { demoWebServer } from './test/helpers/demo-server.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const demoSrc = fileURLToPath(new URL('../../apps/demo/src/', import.meta.url));
const kit = kitPlaywrightConfig({ rootDir: here, target: 'selftest' });

// E04 and S1 type the sign-in persona's password: for the self-tests it is the demo's stand-in, read here from the
// demo's own file and set for the `selftest` target only. A real run gets it from the CLI's 0600 handover file.
if (process.env[ENV.TARGET] === 'selftest' && !process.env[ENV.SIGNIN_PASSWORD_FILE]) {
  const fake = JSON.parse(fs.readFileSync(`${demoSrc}fake-secrets.json`, 'utf8')) as { signinPassword: string };
  process.env[ENV.SIGNIN_PASSWORD] ??= fake.signinPassword;
}

export default defineConfig({
  ...kit.config,
  testDir: 'test/selftest',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { ...kit.config.use, actionTimeout: 15_000, navigationTimeout: 30_000 },
  webServer: demoWebServer({ runId: kit.runId, server: `${demoSrc}server.ts` }),
  // removes the key file the demo wrote for this run
  globalTeardown: `${here}test/helpers/demo-server.ts`,
  projects: [
    {
      name: 'selftest',
      default: true,
      testDir: 'test/selftest',
      use: {
        ...devices['Desktop Chrome'],
        // G12: Chromium's WebRTC must not send UDP around the per-context proxy; this flag is not a proxy flag.
        launchOptions: { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] },
      },
    },
    {
      name: 'demo-e2e',
      default: false,
      testDir: '../../apps/demo/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
