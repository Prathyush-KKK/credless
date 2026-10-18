# Adapters: session providers, key sources, mail sinks and app signals

Five interfaces in `packages/kit/src/types.ts`, exported from `credless/adapters`. An adapter is about 150 lines;
it returns a `Secret` for every sensitive value and never prints one.

## The five interfaces

| Interface | What it does | Built-ins in v0.1 |
|---|---|---|
| `SessionProvider` | `mint(persona, { api, runId })` returns a `SessionGrant` (cookies and/or a storage state, `expiresAt`, `user`) the fixture injects into the persona's context; `verify?(context)` (v0.2) tells whether the session is still valid so the fixture can re-mint | `test-api` (default: `POST /session` through the broker), `storage-state-file` (a Playwright storage-state file per persona; the weaker option) |
| `StateControl` | `health()`, `ensure(ids)`, `reset(ids)`, `state(id)`, `persona(id)`, `handle(id)`, `address(to)`, `messages(to)`, `waitForMessage(to, match)`, `teardown()`, `cleanupRun()`; apps extend the `Control` class with one-call scenarios and reach `this.api`, `this.track()`, `this.secret()`, `this.handles()` | the core `Control`; the demo's `DemoControl` (`workspace()`) |
| `KeySource` | `describe()` for `doctor` (never reads a value), `read()` for `run` (returns a `Secret`) | `env`, `file`, `exec` (argv array, no shell; presets `op`, `infisical`, `doppler`, `vault`, `kubectl`), `keyring` (`@napi-rs/keyring`, optional dependency) |
| `MailSink` | `messages(address, { since, kind, limit })`, `waitFor(address, match, { timeoutMs })`; codes arrive as `Secret` and are registered for masking | `test-api` (default), `mailpit` (`/api/v1/search?query=to:<addr>`, filtered client-side by `Created`) |
| `AppSignals` | `sessionCookies`, `unexpectedSignOut(r)`, `apiError(r)`, `csrf`, `bootCover`: how the app signals what the guard and the session helpers must recognise | defaults: 401 on the api origin is a sign-out; any status ≥ 400 is an API error |

A `module` reference in the config (`session: { provider: 'module', module: './my-provider.ts' }`,
`mail: { sink: 'module', module: ... }`, `control: { module: ... }`) loads your own.

## Writing one

1. Pick the interface. A hosted auth vendor is usually a `SessionProvider` (mint a session for a flagged test user
   through the vendor's API and return the cookies or storage state the app expects); a secret manager is a
   `KeySource`; an inbox is a `MailSink`; a framework is a backend implementation of the seven routes, not an adapter
   in the kit at all ([backend](backend.md)).
2. Keep the credential out of the test. A session provider that needs a vendor secret must get it through the kit's
   broker or your backend, never from `process.env` in a worker; the lint gate and the self-tests will catch the
   obvious ways of doing it wrong.
3. Wrap every sensitive value in a `Secret` (`String()`, template literals, `JSON.stringify` and `util.inspect` say
   `[redacted]`; `reveal()` is called in the one place that sends it) and register one-time codes so screenshots mask
   them.
4. Test against a mock of the vendor's surface in a unit test; add a self-test when the adapter touches the browser.
5. Write the docs page: the auth model, how a session is minted, which of the five locks the backend side can
   implement, the mail or OTP story, the known limits. Add the row below.

## Adapters table

| Adapter | Kind | Tier | Status |
|---|---|---|---|
| `test-api` | SessionProvider, MailSink | core | v0.1 |
| `storage-state-file` | SessionProvider | core | v0.1, documented as the weaker option |
| `env`, `file`, `exec`, `keyring` | KeySource | core | v0.1 |
| `mailpit` | MailSink | core | v0.1 (polished in v0.2) |
| Clerk testing tokens | SessionProvider | core | v0.3 |
| Supabase (service role) | SessionProvider | core | v0.3 |
| OIDC key sources (GitHub, GitLab CI) | KeySource | core | v0.3 |

Tiers: **core** adapters are maintained here; **community** adapters have a named maintainer in this table, CI
against their mock and credit in the release notes.

## Good first adapters

Each is an issue with the interface to implement, a mock to pass and the reference to copy. The ones marked with a
backend note need a backend implementation of the contract more than an adapter.

| Wanted | Kind | Notes |
|---|---|---|
| Clerk | SessionProvider | testing tokens bypass bot detection, not authentication; the secret key stays in the broker or your backend, never in the test environment |
| Supabase | SessionProvider, MailSink | admin client server-side; Mailpit on 54324 in local development |
| Auth0 | SessionProvider | ROPG on a dedicated test connection, enabled only while testing; fails under MFA or Organizations |
| WorkOS Emulate | SessionProvider, MailSink | seeded users and codes as events, local only |
| Rails (Devise) | backend | an engine mounted only in development and staging; the brief's Rails note |
| Django | backend | `login()` in a view behind the key; URL conf gated by the flag |
| Laravel | backend | a route group behind the flag with the Dusk lesson applied (CVE-2024-32003) |
| Spring Boot | backend | `@ConditionalOnProperty` on every bean; a boot guard that always loads |
| Mailpit | MailSink | the search operators and `after:` filter verified against a running instance |
| 1Password | KeySource | `op read` preset exists; a service-account flow with quotas documented |
| Infisical | KeySource | OIDC machine identity for CI, so no static key variable exists |
| Vault, Doppler | KeySource | `vault kv get -field`, `doppler secrets get --plain` presets exist; a `--mount` named-pipe variant for Doppler |
| Firebase Auth emulator | SessionProvider | local only; a service account plus a test UID |
