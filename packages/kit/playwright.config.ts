// The kit's own Playwright config: the `selftest` project (default) runs the fixture, guard, persona, evidence and
// runner self-tests against the demo app; `demo-e2e` (default: false) runs the quickstart suite in apps/demo/e2e.
// Task 6 finishes it: webServer with the `ready web=... api=...` wait regex, reporters, trace options, global setup.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/selftest',
  fullyParallel: true,
  forbidOnly: true,
  // No hidden retries: flakiness is reported by `run --twice`, never retried into green.
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'selftest',
      default: true,
      testDir: 'test/selftest',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'demo-e2e',
      default: false,
      testDir: '../../apps/demo/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
