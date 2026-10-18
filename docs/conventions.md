# Conventions

Frozen by Task 0 (plan §11). Every follow-up task codes against this file and `packages/kit/src/types.ts`; a task
that needs a change proposes a diff to Task 0's owner and never applies it on its own. Where this file and
`types.ts` state the same thing, `types.ts` is the one the code reads. The proposals the v0.1 tasks made, and what
the assembly did with each, are in `docs/DECISIONS.md`.

## 1. Names and the rename

The kit's final name is not chosen. Placeholders: package `kit`, CLI `kit`, env prefix `KIT_`. They live in
`packages/kit/src/brand.ts` (`KIT_NAME`, `CLI_NAME`, `ENV_PREFIX`; `CANARY_HOST` derives from `KIT_NAME`). A rename
is: those three constants, `name` and the `bin` key in `packages/kit/package.json`, and the `kit` dependency key in
`apps/demo/package.json`. Nothing else spells the name; messages, env names, staging paths and the canary host are
built from the constants. Root scripts filter by path (`--filter ./packages/kit`), not by name.

Also spelled by the name, so a rename touches them too: `packages/kit/templates/` (the file `credless.config.ts` and
the import specifiers inside the templates), `plugins/credless/` (the folder, `plugin.json`, `hooks.json`),
`.claude-plugin/marketplace.json`, the skill text, `apps/demo/e2e/credless.config.ts`, and the default paths of
`scripts/skill-sync.mjs` and `scripts/skill-validate.mjs` (repo-root scripts that import nothing from `brand.ts`).

## 2. Environment variables (`ENV` in types.ts)

| Name | Set by | Read by | Meaning |
|---|---|---|---|
| `CREDLESS_TARGET` | CLI | config loader | the target name (a key of `targets`) |
| `CREDLESS_SLOT` | CLI (`--slot`) | config loader | agent slot letter, `^[a-z]$`, default `a` |
| `CREDLESS_RUN_ID` | config (pinned once) | every process of the run | `^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$` |
| `CREDLESS_REPORT_DIR` | CLI | fixtures, post-run | this run's evidence dir while live (inside staging) |
| `CREDLESS_STAGING_DIR` | person or CI (optional) | CLI, doctor | the private 0700 staging dir; default below |
| `CREDLESS_BROKER_URL` | global setup | workers | `http://127.0.0.1:<port>` |
| `CREDLESS_BROKER_TOKEN` | global setup | workers | per-run token; worthless after the run |
| `CREDLESS_RUNNER_KEY` | CI / a person (the `env` key source) | the CLI, which takes it over and unsets it | the test-API key; never in a worker's environment |
| `CREDLESS_RUNNER_KEY_FILE` | CLI | global setup (read once, deleted) | the 0600 handover file |
| `CREDLESS_SIGNIN_PASSWORD` | self-tests only | the sign-in test | the demo's stand-in; real runs use the file |
| `CREDLESS_SIGNIN_PASSWORD_FILE` | CLI | the sign-in test | 0600 file in staging |
| `CREDLESS_EVIDENCE_KEY` | CLI (random per run) | fixtures, post-run | HMAC key for the list of codes to scrub; never written |
| `CREDLESS_SCRUB_VALUES_FILE` | CLI | post-run (read once, deleted) | NUL-separated secret values to scrub by value |
| `CREDLESS_WORKERS` | CLI (`--workers`) | Playwright config | worker count |
| `CREDLESS_TRACE` | person | Playwright config | `off`, `retain-on-failure` (default), `on` |
| `CREDLESS_GUARD_OUTSIDE` | person | guard | `fail` (default) or `note` |
| `CREDLESS_A11Y` | person | fixtures | `gate` makes serious/critical axe findings fail |
| `CREDLESS_WEB_URL`, `CREDLESS_API_URL` | person | config loader | origin overrides; must pass the same checks |
| `CREDLESS_WORKER_PROXY_URL` | global setup (`loopback`); `run` in v0.2 (a URL) | the worker shim | unset or `off`: inert; `loopback`: workers may dial loopback only; a URL: that proxy too, published as `HTTP(S)_PROXY`. A person sets `off` to diagnose a false positive |
| `CREDLESS_DEMO_KEY_FILE` | the harness (`playwright.config.ts`) or `credless demo` | `apps/demo/src/server.ts`, the demo configs | the 0600 file holding the demo's stand-in runner key; the demo writes it with `--write-key <same path>` and the config's `file` key source reads it |

No other `KIT_*` variable exists without a row here. Nothing secret is ever passed as a CLI argument.

## 3. Exit codes (`EXIT`)

`0` pass and the evidence is clean. `1` a test failed, or a secret VALUE was found in the evidence (scrubbed, kept,
and the run failed because a code path leaked). `2` usage: unknown or production target, bad flag, missing tool,
lock held past `--wait`, no key source, doctor refused. `4` the evidence is not safe to keep: post-run failed or
something secret-shaped survived the scrub; the staging folder is deleted. The GitHub Action exits with the same
code. Post-run writes its marker `.post-run-done` (containing the code) last; a run folder without the marker is
never moved out of staging. The marker travels with the folder: a kept `reports/<run id>/` always has it.

## 4. Test API: base path, headers, handles

- Base path `/_test` on the api origin (`testApi.basePath`; `targets.<t>.testApi` when another origin serves it).
- Runner key header `X-Test-Runner-Key` (`testApi.keyHeader`). Broker token header `X-Test-Broker-Token` (fixed).
- Answers are plain JSON, no envelope. Refusals: HTTP status plus `{ "error": { "code", "message" } }`.
- Status use: 401 key, 403 not a test account or address outside the range, 404 flag off (route absent) or unknown
  object, 409 conflict, 422 contract violation, 429 session rate limit.
- The seven core routes are `CORE_ROUTES` in types.ts and `contract/core.openapi.yaml`; an app's routes live in its
  own OpenAPI file under the same base path, and `health.extensions` lists their operationIds.
- The broker forwards contract routes only (core plus the app's), never follows redirects, forwards only listed
  request headers, and returns status, body and `Set-Cookie`.

## 5. Identifiers (`PATTERNS`)

| What | Shape | Example |
|---|---|---|
| run id | `^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$` | `20261008T101500Z-ab12` |
| slot | `^[a-z]$` | `a` (CI uses `z`) |
| namespace | `^[a-z][0-9]{1,2}$` = slot + worker parallel index | `a0` |
| persona id | `^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$` | `owner`, `second-owner` |
| handle | `<namespace>.<persona>` | `a0.owner` |
| address | `addressTemplate` rendered, inside `personas.addressPattern` | `qa+a0-owner@example.com` |
| one-time code | `evidence.codeShape`, default six digits | masked as `418203`, `418 203`, `418-203` |
| user id | string, opaque | `"u_8f3a"` |
| epoch fields | seconds, not milliseconds | `expiresAt`, `sentAt`, `since` |

## 6. Fixtures, helpers and attachments

Test fixtures: `personas`, `control`, `guard`, `shot`, `sensitive`. Worker fixture: `kit`. Helpers from the main
entry: `about`, `typeSecret`, `clearSecretField`, `see`, `notSee`, `Secret`, `expect`. `PersonaSession` methods:
`goto`, `shot`, `api`, `a11y`, `aria`.

Annotations `about()` writes: `source`, `expected`. Attachments the fixtures write: `test-api-calls` (method, path,
status, ms per call), `<persona>-<list>` for the guard lists (`outside`, `third-party`, `dev-hosts`,
`analytics-blocked`, `api-errors`, `cancelled`), `<persona>-a11y` (JSON). A passed test that opened a screen and
saved no shot fails ("opened a screen but saved no screenshot"). The guard's violation for an unlisted host reads
`request to an unlisted host: <method> <url>`; SUMMARY.md's "Hosts outside the run" table is built from that phrase
and from the guard attachments, so the wording is part of the contract.

## 7. Evidence folder (`EVIDENCE`)

```text
reports/<run id>/
  SUMMARY.md  COVERAGE.md  FLAKES.md (--twice)  QUARANTINED.md (if any)  run.json  suite.json  scan.json
  contact-sheets/contact-sheet-<project>.png
  shots/<case>--<persona>-<step>-<project>.png        (-FAILED- as the step: triage shot, masked like every shot)
  aria/<case>--<persona>-<step>.yaml
  html/  junit.xml  results.json  ctrf.json  blob/report.zip
  artifacts/<test>/trace.zip (scrubbed)  artifacts/<test>/error-context.md (scrubbed)
  .post-run-done                                       (the marker; written last)
```

`<case>` is the test title slugged (`[^A-Za-z0-9._-]+` to `-`, max 80), `<persona>` the persona id (max 24),
`<step>` the step slugged (max 40). Screenshots mask `input[type="password"], [data-sensitive]`, the config's
`maskSelectors` and every code in play, in `#FF00FF`. During the run the folder lives in staging as
`<staging>/<run id>/` and `.sensitive-hashes` (HMACs of codes under `CREDLESS_EVIDENCE_KEY`) sits beside the files;
post-run deletes it before the move.

Pipeline, fail-closed: scrub (by value in four encodings: raw, URL-encoded, base64, JSON-escaped; inside zips,
nested zips and the base64 zip embedded in the HTML report; traces, results.json, junit.xml, ctrf.json, blob,
error-context.md, logs) then scan (read-only; lists file and kind, never a value) then quarantine (a file with a
surviving finding is deleted and listed) then contact sheets, COVERAGE, FLAKES, SUMMARY, then the marker, then
`mv` to `reports/<run id>/`. Anything else (exit 4, a crash, a kill before the marker): `rm -rf` of the staging run.

Evidence key fallback: when `CREDLESS_EVIDENCE_KEY` is unset (a run not started by the CLI) the fixtures and the scrub
key the HMACs with the run id instead; a code is hashed with its separators removed, and the scrub also tries the raw
form.

## 8. Secrets: handover and handling

- Where the key is, moment by moment: the key source; one unexported variable of the CLI process, which deletes it
  from its own environment; a 0600 file `.secret-<pid>-key` in the 0700 staging dir for the seconds between spawn and
  global setup; the broker's memory until teardown. Never a worker's environment, the browser, a container config,
  argv or the evidence.
- Handover protocol: the CLI writes the value with `umask 077` semantics (`O_CREAT|O_EXCL`, mode 0600) into the
  0700 staging dir, passes the PATH in `CREDLESS_RUNNER_KEY_FILE`; the reader (`global-setup.ts`) reads it once and
  deletes it in a `finally`, then deletes the variable from `process.env`. The same for `CREDLESS_SIGNIN_PASSWORD_FILE`
  (read by the one sign-in test) and `CREDLESS_SCRUB_VALUES_FILE` (read by post-run, NUL-separated). Mode bits are
  advisory on Windows; `doctor` says so.
- Staging dir default: `$XDG_CACHE_HOME/<kit>/staging` or `~/.cache/<kit>/staging` on POSIX,
  `%LOCALAPPDATA%\<kit>\staging` on Windows; `CREDLESS_STAGING_DIR` or `evidence.stagingDir` overrides it (a repo-local
  `.staging/` is gitignored). Lock per target and slot: `mkdir <staging>/.lock-<target>-<slot>` with the owner pid
  inside; a lock whose owner is gone is taken over. Orphan `.secret-<pid>-*` files of dead pids are swept at start.
- In code: a secret is a `SecretValue` (the `Secret` class). `String()`, template literals, `JSON.stringify` and
  `util.inspect` say `[redacted]`; `reveal()` is called in the one place that sends the value. Every revealed value is
  registered with the redactor; every error that could quote a header is rebuilt (`sanitizedError`). Values shorter
  than 6 characters are not registered.
- The CLI spawns with an environment allowlist, never `process.env`; `execFile` with argv arrays, never a shell; the
  child's stdio passes through a redacting `Transform`.
- `doctor` reports a key source by presence (`describe()`), never by reading it.

## 9. Egress: verdicts, canary, limits

- Verdicts (`EgressVerdict`), judged on host and port BEFORE any DNS lookup, in this order: `prod` (refused,
  violation), `canary` (answered 204 by the proxy itself, recorded with the context id), `own` (pass),
  `analytics` (refused, listed), `third-party` (pass on 80/443, listed), `dev` (pass on 80/443, listed), `outside`
  (refused; violation, or listed under `CREDLESS_GUARD_OUTSIDE=note`). After the verdict: `dns.lookup(host, { all: true })`
  once; an address in `PRIVATE_RANGES` is `private` (refused) unless the target's `kind` is `local`; the first
  address is dialled with the original `Host`/SNI and pinned for the connection.
- Canary host: `canary.<kit>.invalid` (`CANARY_HOST`). After each context is created the fixture calls
  `context.request.get('http://canary.<kit>.invalid/')`; the test fails with "egress proxy bypassed" unless its own
  proxy saw it. The worker fixture also refuses to start when `testInfo.project.use.proxy` is set or
  `launchOptions.args` carries `--proxy-server`, `--proxy-bypass-list` or `--host-resolver-rules`.
- Limits (`EGRESS_LIMITS`): 16 KiB of request line and headers, 64 concurrent tunnels per proxy, 60 s idle.
- Host rules in config are strings: exact hostnames or `*.label.tld` globs. A rule that would match a production host
  is refused at load.

## 10. The demo app: what Task 2 (guard, fixtures, self-tests) and Task 5 (demo) both implement

Ports: web and api listen on ephemeral loopback ports and print one line to stdout:
`ready web=http://127.0.0.1:<p> api=http://127.0.0.1:<q>`; `playwright.config.ts` uses
`webServer.wait: /ready web=(?<DEMO_WEB>\S+) api=(?<DEMO_API>\S+)/`. Sentinels are fixed: TCP `127.0.0.1:4319`
(an HTTP server that counts hits and destroys upgrades; a request reaching it is a leak) and UDP `127.0.0.1:3478`
(counts datagrams: STUN/TURN from WebRTC).

The demo writes its stand-in runner key with `--write-key <file>` (mode 0600, never overwriting) and both configs
(`packages/kit/credless.config.ts`, `apps/demo/e2e/credless.config.ts`) read it through `CREDLESS_DEMO_KEY_FILE` with
the `file` key source; without the variable the `env` source applies (a demo started by hand with the key from
`fake-secrets.json`). The harness (`packages/kit/test/helpers/demo-server.ts`) and `credless demo` both do this.

Demo config: `targets.selftest = { web: DEMO_WEB, api: DEMO_API, kind: 'local' }`;
`production = { domains: ['example.com'], words: ['prod', 'production'], nonProductionPattern: '^dev\\.example\\.com$' }`;
`hosts.thirdParty = []`, `hosts.analytics` = the kit's defaults (which include `*.googletagmanager.com`).
Cookies: session `sid` (HttpOnly, SameSite=Lax, Max-Age 3600) and CSRF double-submit `csrf` with header
`X-CSRF-Token`; `signals.sessionCookies = ['sid']`. Sign-out signal: 401 on the api origin (the default).

Pages on the WEB origin (private `/__mock/*` renamed one to one; `ready` dropped in favour of the wait regex):

| Route | Behaviour | Self-test |
|---|---|---|
| `/__demo/console-error` | `console.error('boom from the app')` | G01, G07, G08 |
| `/__demo/outside` | `fetch('https://outside.example/beacon')` | G02 |
| `/__demo/analytics` | loads `https://www.googletagmanager.com/gtag/js?id=G-TEST` | G03 |
| `/__demo/prod` | `fetch('https://www.example.com/config')` (production by domain rule) | G04 |
| `/__demo/expired` | `GET <api>/api/expired-on-purpose` (answers 401) | G05 |
| `/__demo/http-error` | `GET <api>/__demo/not-here` (answers 404) | G06 |
| `/__demo/password` | a password field reporting the typed length only | E04 |
| `/__demo/webrtc` | `RTCPeerConnection` with STUN and TURN at `127.0.0.1:3478` | G12 |
| `/__demo/websocket?to=` | opens a WebSocket to `to` (default `ws://127.0.0.1:4319/socket`; the prod case uses `wss://app.prod.example/socket`) | G11 |
| `/__demo/redirect-out` | 302 to `http://127.0.0.1:4319/landing` | G09 |
| `/__demo/redirect-prod` | 302 to `https://app.prod.example/j/abc` (production by word rule) | G10 |
| `/__demo/sentinel` | JSON `{ "hits": n, "datagrams": n }` | G02, G09, G11, G12 |

Routes on the API origin:

| Route | Behaviour |
|---|---|
| `/__demo/not-here` | always 404 |
| `/__demo/api-redirect` | 302 to `http://127.0.0.1:4319/from-api` (persona `api()` must not follow it) |
| `/__demo/state` | introspection for the self-tests: counts and the audit tail, never a cookie or a code |
| `/api/expired-on-purpose` | 401 `{ "error": { "code": "session-expired" } }` |

Demo personas (`apps/demo/e2e/personas.yaml`): `owner`, `member`, `guest`, `second-owner`, `signin` (auth
`password`), plus the address `ghost`. Address template `qa+{ns}-{persona}@example.com`, last-name template
`QA-{ns}`, address pattern `^qa\+[a-z0-9-]+@example\.com$`. The demo's stand-in secrets (runner key, sign-in
password) live in `apps/demo/src/fake-secrets.json` and are scanned for like real ones.

## 11. Dependencies

Tasks never edit a `package.json`. Everything the eight tasks need is declared: runtime `zod`, `yaml`, `fflate`,
`@axe-core/playwright`; peer `@playwright/test >=1.64 <2` (dev-pinned 1.64.1); optional `@napi-rs/keyring`,
`playwright-ctrf-json-reporter`; dev `vitest`, `tsdown`, `typescript 5.9`, `@types/node 24`, `@biomejs/biome`,
`publint`, `@arethetypeswrong/cli`, `@changesets/cli`; `apps/demo` declares `vitest` for its own server test. A new
dependency is a line in `docs/DECISIONS.md` with the reason, never a silent addition. Install scripts are off (`.npmrc`, `pnpm-workspace.yaml`); a package that needs one
is a decision, not a line.

## 12. Toolchain constraints

Node ≥ 24.12 is what the published package declares; the workspace also runs on Node 22.18+ because every `.ts` is
erasable (no enums, no parameter properties, no namespaces, no `import =`) and relative imports carry the `.ts`
extension (`rewriteRelativeImportExtensions`). Type check with TypeScript 5.9 (`pnpm typecheck`); TypeScript 7 is
evaluated in v0.2. ESM only. Biome 2.5 formats and lints (120 columns, single quotes, trailing commas); the
override for `**/e2e/**`, `test/selftest/**` and `packages/kit/templates/**` forbids network and process imports and
the globals `fetch` and `process` (the AST gate `check-tests` is the authoritative one); a `*.config.ts` in those
directories is exempt from the override, and `check-tests` skips it in a directory walk (a config reads the harness's
environment by design) while still checking a file named on the command line. `packages/kit/test/helpers/` is the
one place self-test harness code may use the file system and processes. Playwright test files use `test.step` and
the kit's fixtures only; no `chromium.launch`, `newContext`, `request.newContext`, `proxy`, `launchOptions` or
`egressLookup` in test dirs.

## 13. No organisation-specific strings

Nothing in this repo names the private origin: no product name, hostname, domain, mail address, person or team
name, internal document id, profile id or ticket key. Generic examples use `example.com`, `app.example`,
`api.example`, `outside.example`, reserved TLDs (`.example`, `.invalid`, `.test`), `qa+<ns>-<persona>@example.com`.
Catalogue of forbidden classes (the actual patterns live in a private, uncommitted list and run in Task 8's gate):

1. product and company names (any casing, with and without separators);
2. the company's domains and every host under them;
3. mail addresses and address ranges on those domains;
4. people's and teams' names, cloud profile or account ids;
5. internal document and case-list ids, ticket keys, runbook names;
6. the private framework's own cookie names, header names and environment-variable prefix.

Gate pattern (Task 8 wires it into `check` with the private list; this is the shape):

```sh
rg -n -i --hidden --glob '!node_modules' --glob '!.git' --glob '!pnpm-lock.yaml' \
   -f "$PRIVATE_PATTERNS_FILE" . && { echo 'org-specific string found'; exit 1; } || echo 'clean'
```

The same gate runs in every task's done check with the patterns that task's agent knows; a hit is a fix, never an
exception.

## 14. Task etiquette

Tasks 1–5 and 7–8 run in parallel after Task 0; Task 6 runs last and is the only one that edits the root CI. Each
task adds tests under its own folder and touches no other task's files. Disagreements with `types.ts` or this file
are raised as a proposed diff to Task 0's owner. Each task's done check includes `pnpm lint`, `pnpm typecheck` and
the string gate above.
