// The kit's own config: its self-tests run against the demo app (apps/demo) under the `selftest` target. The demo's
// origins arrive as DEMO_WEB and DEMO_API (the webServer wait regex of playwright.config.ts, or `credless demo`);
// the stand-in runner key is the 0600 file CREDLESS_DEMO_KEY_FILE names, which the demo wrote for this run. Nothing
// here is a secret, and the fixed ports are only for a demo started by hand (`--web-port 4310 --api-port 4311`).
import { defineConfig } from './src/config/index.ts';

const env = process.env;
const web = env.DEMO_WEB ?? 'http://127.0.0.1:4310';
const api = env.DEMO_API ?? 'http://127.0.0.1:4311';
const keyFile = env.CREDLESS_DEMO_KEY_FILE;

export default defineConfig({
  targets: {
    selftest: { web, api, kind: 'local' },
  },
  production: {
    domains: ['example.com'],
    words: ['prod', 'production'],
    nonProductionPattern: '^dev\\.example\\.com$',
  },
  // Nothing third-party is allowed; the tag manager the /__demo/analytics page loads is aborted and listed (G03).
  hosts: { thirdParty: [], analytics: ['analytics.example', '*.googletagmanager.com'] },
  personas: { catalog: '../../apps/demo/e2e/personas.yaml', addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$' },
  // the demo's extension routes, so the broker forwards them to the workspace control (C01, C04, C05)
  testApi: {
    basePath: '/_test',
    keyHeader: 'X-Test-Runner-Key',
    contract: '../../apps/demo/contract/demo.openapi.yaml',
  },
  // without the file (a demo started by hand with the key from fake-secrets.json) the `env` source applies
  key: keyFile ? { source: 'file', path: keyFile } : { source: 'env' },
  signals: { sessionCookies: ['sid'], csrf: { cookie: 'csrf', header: 'X-CSRF-Token' } },
  control: { module: '../../apps/demo/e2e/demo.control.ts' },
  evidence: { bootCover: '[data-boot-cover]' },
});
