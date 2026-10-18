// credless configuration, written by `credless init`. Edit it by hand afterwards. Nothing in this file is secret: the
// runner key is read at run time from the `key` source below, by the CLI, and never from this file or from test code.
import { defineConfig } from 'credless/config';

export default defineConfig({
  // Every environment a run may point at. Production is never one of them: the loader refuses a target whose host
  // matches `production`, and every persona browser's egress proxy refuses production hosts before DNS.
  targets: {
    staging: { web: 'https://app.staging.example', api: 'https://api.staging.example' },
    // local: { web: 'http://127.0.0.1:3000', api: 'http://127.0.0.1:4000', kind: 'local' },
  },

  // What counts as production: a host under one of these domains (unless it is a target host or matches
  // `nonProductionPattern`), or a host with one of `words` as a label part anywhere (default: prod, production).
  production: {
    domains: ['example.com'],
    // nonProductionPattern: '^(dev|staging)-[a-z0-9]+\\.example\\.com$',
  },

  // Hosts the app may reach besides its own origins. Anything else fails the test (`outside: 'note'` lists instead).
  hosts: {
    thirdParty: [],
    // analytics: ['*.googletagmanager.com'],
  },

  personas: {
    catalog: './personas.yaml',
    // Every rendered persona address must match; the test API enforces the same range on its side.
    addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$',
  },

  // The backend's test API: base path `/_test` and header `X-Test-Runner-Key` by default. Point `contract` at your
  // app's extension routes (OpenAPI) so the broker forwards them.
  // testApi: { contract: './e2e/test-api.openapi.yaml' },

  // Where the runner key comes from. Only the CLI reads it; `credless doctor` reports it by presence.
  //   env:     CI passes CREDLESS_RUNNER_KEY to the one `run` step. On a laptop prefer `exec`, so the value never sits
  //            in a shell you export from.
  //   exec:    a secret manager's CLI, run by the CLI with an argv array and no shell (presets: op, infisical, doppler,
  //            vault, kubectl; or your own `argv`).
  //   file:    a 0600 file, read once.  keyring: the OS keyring (optional dependency @napi-rs/keyring).
  key: { source: 'env' },
  // key: { source: 'exec', preset: 'op', ref: 'op://Engineering/credless staging/runner-key' },
  // key: { source: 'exec', preset: 'infisical', ref: 'CREDLESS_RUNNER_KEY' },
  // key: { source: 'exec', preset: 'doppler', ref: 'CREDLESS_RUNNER_KEY' },
  // key: { source: 'exec', preset: 'vault', ref: 'secret/credless/staging:runner-key' },
  // key: { source: 'exec', argv: ['my-secrets', 'read', 'credless/staging/runner-key'] },
  // key: { source: 'file', path: '/run/secrets/credless-runner-key' },
  // key: { source: 'keyring', service: 'credless', account: 'staging' },

  // The app's control extension (a class extending the kit's Control with your setup methods), once you have one.
  // control: { module: './e2e/control.ts' },

  // How the app signals things the guard must recognise. Defaults: a 401 on the api origin is a sign-out, any
  // status >= 400 is an API error, `sid` is the session cookie.
  // signals: { sessionCookies: ['sid'], csrf: { cookie: 'csrf', header: 'X-CSRF-Token' } },

  evidence: {
    reportsDir: 'reports',
    // bootCover: '[data-boot-cover]', // shots wait until the app's splash or skeleton is gone
    // maskSelectors: ['[data-testid="invite-code"]'], // masked in every screenshot, besides password fields
  },

  // Browser projects, passed through to Playwright. One desktop project is the quick first look.
  // browsers: [{ name: 'desktop', use: { viewport: { width: 1280, height: 800 } } }],
});
