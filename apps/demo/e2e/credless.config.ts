// The demo suite's config (docs/conventions.md §10). The harness starts the demo on ephemeral ports and exposes them
// as DEMO_WEB and DEMO_API (Playwright's `webServer.wait` named groups); the fixed ports are for a demo started by
// hand with `--web-port 4310 --api-port 4311`. The runner key is a stand-in the demo writes to the file named by
// CREDLESS_DEMO_KEY_FILE; without that variable the `env` key source applies (CREDLESS_RUNNER_KEY), so a person can
// point the suite at a demo running with the key from apps/demo/src/fake-secrets.json.
import { defineConfig } from 'credless/config';

// biome-ignore lint/style/noRestrictedGlobals: the config is the one file of the suite that reads the harness's environment; tests read none
const env = process.env;
const web = env.DEMO_WEB ?? 'http://127.0.0.1:4310';
const api = env.DEMO_API ?? 'http://127.0.0.1:4311';
const keyFile = env.CREDLESS_DEMO_KEY_FILE;

export default defineConfig({
  targets: {
    demo: { web, api, kind: 'local' },
    // the kit's own self-tests run against the same demo under this name (`run --target selftest`)
    selftest: { web, api, kind: 'local' },
  },
  production: {
    domains: ['example.com'],
    words: ['prod', 'production'],
    nonProductionPattern: '^dev\\.example\\.com$',
  },
  // Nothing third-party is allowed; the kit's analytics defaults (the tag manager the /__demo/analytics page loads)
  // plus the demo's own analytics host are aborted and listed, never failures.
  hosts: { thirdParty: [], analytics: ['analytics.example', '*.googletagmanager.com'] },
  personas: { catalog: './personas.yaml', addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$' },
  testApi: { basePath: '/_test', keyHeader: 'X-Test-Runner-Key', contract: '../contract/demo.openapi.yaml' },
  key: keyFile ? { source: 'file', path: keyFile } : { source: 'env' },
  signals: { sessionCookies: ['sid'], csrf: { cookie: 'csrf', header: 'X-CSRF-Token' } },
  control: { module: './demo.control.ts' },
  evidence: { bootCover: '[data-boot-cover]' },
});
