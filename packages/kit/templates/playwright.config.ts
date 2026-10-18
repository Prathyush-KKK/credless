// Playwright config written by `credless init`. The kit decides what every run needs the same way: the reporters
// into the run's evidence folder, the global setup that takes the runner key over and starts the broker, trace and
// worker knobs from the environment `credless run` sets, and no retries (flakiness is reported by `run --twice`,
// never retried into green). Add your projects below; keep `retries` at 0.
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { kitPlaywrightConfig } from 'credless/config';

const kit = kitPlaywrightConfig({ rootDir: fileURLToPath(new URL('.', import.meta.url)) });

export default defineConfig({
  ...kit.config,
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
