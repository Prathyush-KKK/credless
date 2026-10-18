// The quickstart suite's Playwright config: the kit's defaults (the reporters into the evidence folder, the global
// setup that takes the key over and starts the broker, no retries) plus one desktop project. `credless demo` starts
// the demo app itself and hands this run its origins (DEMO_WEB, DEMO_API) and its key file; a bare
// `npx playwright test` in this directory starts the demo as Playwright's webServer instead, the way the kit's own
// self-tests do, with the demo's stand-in password for the one sign-in test.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { kitPlaywrightConfig } from 'credless/config';
import { demoWebServer } from '../../../packages/kit/test/helpers/demo-server.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = fileURLToPath(new URL('../src/', import.meta.url));
// the kept evidence lands in apps/demo/reports (credless.config.ts says the same in `evidence.reportsDir`)
const kit = kitPlaywrightConfig({ rootDir: here, reportsDir: '../reports', target: 'demo' });
const standalone = !process.env.DEMO_WEB;

if (standalone && !process.env.CREDLESS_SIGNIN_PASSWORD_FILE) {
  const fake = JSON.parse(fs.readFileSync(`${src}fake-secrets.json`, 'utf8')) as { signinPassword: string };
  process.env.CREDLESS_SIGNIN_PASSWORD ??= fake.signinPassword;
}

export default defineConfig({
  ...kit.config,
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { ...kit.config.use, actionTimeout: 15_000, navigationTimeout: 30_000 },
  ...(standalone
    ? {
        webServer: demoWebServer({ runId: kit.runId, server: `${src}server.ts` }),
        globalTeardown: fileURLToPath(new URL('../../../packages/kit/test/helpers/demo-server.ts', import.meta.url)),
      }
    : {}),
  projects: [{ name: 'demo-e2e', use: { ...devices['Desktop Chrome'] } }],
});
