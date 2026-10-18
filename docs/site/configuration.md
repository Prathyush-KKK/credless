# Configuration reference: credless.config.ts and the persona catalog

`credless.config.ts` exports `defineConfig({...})` from `credless/config`; zod validates it and returns it. Every
host rule is a string, so the config is serialisable to workers and to `doctor`. The shapes below are the
`KitConfig` interface in `packages/kit/src/types.ts`; where this page and the types differ, the types win.

```ts
import { defineConfig } from 'credless/config';

export default defineConfig({
  targets: { dev: { web: 'https://dev.app.example.com', api: 'https://dev.api.example.com' } },
  production: { domains: ['example.com'], nonProductionPattern: '^(dev|staging)\\.' },
  personas: { catalog: './personas.yaml', addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$' },
  key: { source: 'env' },
});
```

## `targets` (required)

`Record<string, Target>`: the environments a run can point at. `--target <name>` picks one.

| Field | Type | Meaning |
|---|---|---|
| `web` | string | the web app's origin, for example `https://dev.app.example.com` |
| `api` | string | the backend's origin |
| `testApi` | string? | the origin that serves the test API when it is not `api` |
| `kind` | `'local' \| 'remote'`? | `local` targets may resolve to loopback and private addresses (the demo); `remote` (default) may not |

`CREDLESS_WEB_URL` and `CREDLESS_API_URL` override a target's origins for one run; the overrides pass the same checks.

## `production` (required)

| Field | Type | Meaning |
|---|---|---|
| `domains` | string[] | the organisation's domains, for example `['example.com']`; a host on or under one is production unless it is a target host or matches `nonProductionPattern` |
| `words` | string[]? | default `['prod', 'production']`; a host with one of these as a label or label part is production, anywhere |
| `nonProductionPattern` | string? | a regular expression source matched against the whole hostname, for example `'^(dev|staging)-[a-z]+\\.example\\.com$'` |

Production and the target hosts can never overlap; the loader refuses a config where they do. A production host is
refused by the config loader, the guard, the egress proxy (before DNS) and the broker.

## `hosts`

| Field | Type | Meaning |
|---|---|---|
| `thirdParty` | HostGlob[]? | hosts the app loads at boot or on known screens: let through on 80/443 and listed per test |
| `analytics` | HostGlob[]? | aborted before they leave, listed, never failures; the kit's defaults include `*.googletagmanager.com` |
| `outside` | `'fail' \| 'note'`? | what the guard does with a host nobody listed: fail the test (default) or only list it (`CREDLESS_GUARD_OUTSIDE=note` for one run) |

A `HostGlob` is an exact hostname or a glob with a leading `*.` label (`'*.googleapis.com'`). A rule that would
match a production host is refused at load.

## `personas` (required)

| Field | Type | Meaning |
|---|---|---|
| `catalog` | string | path of the persona catalog YAML, relative to the config file |
| `addressPattern` | string | a regular expression source every rendered address must match; the test API enforces the same range on its side |
| `slot` | string? | the slot letter `^[a-z]$`, default `a`; `--slot` overrides |
| `workers` | number? | default 2 for a remote target; `--workers` overrides |

### The catalog (`personas.yaml`)

```yaml
version: 1
status: draft                              # draft | confirmed
addressTemplate: qa+{ns}-{persona}@example.com   # must contain {ns} and {persona}
lastNameTemplate: QA-{ns}                        # must contain {ns}
defaults:
  locale: en-US
  timezone: UTC
  auth: session                            # session (minted) | password (UI sign-in only)
personas:
  owner:
    role: owner                            # free-form; your test API interprets it
    firstName: Olivia                      # unique in the catalog, so screenshots tell people apart
    purpose: creates workspaces and documents; the head of every scenario
    usedBy: [workspaces §1-3]
  member:
    role: member
    firstName: Marcus
    purpose: an invited member; removed in the access cases
  guest:
    role: guest
    firstName: Gwen
    purpose: an outsider who must see nothing of a workspace
  signin:
    role: member
    firstName: Sam
    auth: password
    purpose: the one persona that signs in through the UI, for the sign-in screen test
addresses:
  ghost:
    template: qa+{ns}-ghost@example.com
    purpose: an invited address nobody answers for
```

Per persona: `role`, `firstName`, `purpose` (required), `auth`, `locale`, `timezone`, `countryCode`, `attributes`
(app-specific, sent to the test API in `PersonaSpec.attributes`), `usedBy`. `pnpm catalog:check` validates it.

## `testApi`

| Field | Type | Meaning |
|---|---|---|
| `basePath` | string? | default `/_test` |
| `keyHeader` | string? | default `X-Test-Runner-Key` |
| `contract` | string? | path of the app's extension contract (OpenAPI); merged with the core contract for the broker's allowlist |
| `headers` | Record<string, string>? | headers the client sends on every test-API call (device or client headers a backend filters on) |

## `key` (required)

Where the runner key comes from. `doctor` prints the source by presence (`describe()`); only `run` reads a value.

| `source` | Fields | Meaning |
|---|---|---|
| `env` | `name?` | an environment variable of the CLI process, default `CREDLESS_RUNNER_KEY`; the CLI takes it over and unsets it. For CI |
| `file` | `path` | read once; must be mode 0600 on POSIX (advisory on Windows) |
| `exec` | `argv?` or `preset?` + `ref?` | a full argv run with `execFile`, no shell: `['op', 'read', 'op://vault/item/field']`; presets `op`, `infisical`, `doppler`, `vault`, `kubectl` take a `ref` |
| `keyring` | `service`, `account` | the OS keyring through `@napi-rs/keyring` (optional dependency) |

## `session`

| `provider` | Fields | Meaning |
|---|---|---|
| `test-api` | | default: `POST /session` through the broker; the cookies the backend sets are injected into the persona's context |
| `storage-state-file` | `dir` | a Playwright storage-state file per persona id (`<dir>/<persona>.json`); the weaker option, documented as such |
| `module` | `module` | a module whose default export is a `SessionProvider` |

## `control`

| Field | Meaning |
|---|---|
| `module` | a module whose default export is a class extending the kit's `Control`; its methods appear on the `control` fixture ([backend](backend.md#extension-routes)) |

## `mail`

| `sink` | Fields | Meaning |
|---|---|---|
| `test-api` | | default: `GET /personas/{handle}/messages` |
| `mailpit` | `url` | Mailpit's API origin, for example `http://127.0.0.1:8025` |
| `module` | `module` | a module whose default export is a `MailSink` |

## `signals`

How the app signals things the kit must recognise (`Partial<AppSignals>`):

| Field | Default | Meaning |
|---|---|---|
| `sessionCookies` | | cookie names the scrubber and `narrowCookies` treat as sessions (`['sid']`) |
| `unexpectedSignOut(r)` | a 401 on the api origin | the guard fails the test on it |
| `apiError(r)` | any status ≥ 400 | the app-level error code of a response (its status, or an envelope code), or null |
| `csrf` | | `{ cookie, header }` of a double-submit pair, so `session.api()` can send mutations like the app does |
| `bootCover` | | the selector of the app's boot cover; shots wait until it is gone |

## `evidence`

| Field | Default | Meaning |
|---|---|---|
| `reportsDir` | `reports` | where kept evidence goes: `<reportsDir>/<run id>/` |
| `stagingDir` | the per-user cache dir | the private 0700 staging dir (`$XDG_CACHE_HOME/credless/staging`, `~/.cache/credless/staging`, `%LOCALAPPDATA%\credless\staging`); `CREDLESS_STAGING_DIR` overrides |
| `bootCover` | | a selector for the app's boot cover (splash, skeleton) |
| `maskSelectors` | | selectors masked in every screenshot, in addition to `input[type="password"], [data-sensitive]` |
| `codeShape` | `digits6` | what counts as a one-time code for masking and scrubbing: `digits6` or a regular expression source |
| `trace` | `retain-on-failure` | `off`, `retain-on-failure`, `on`; `CREDLESS_TRACE` overrides |
| `retainOnPass` | false | keep traces of passed tests too |

## `browsers`

An array of `{ name, use, metadata? }`; each becomes a Playwright project with `use` passed through. `metadata`
(`size`, `theme`) labels the contact sheets. The kit refuses a `use.proxy` and proxy flags in `launchOptions.args`.

## `docker`

| Field | Meaning |
|---|---|
| `image` | the Playwright image; the runner pins it by digest, and `doctor` refuses a different tag unless it is pinned |
| `isolate` | v0.2: run with no route to the network except the sidecar egress proxy |

## Environment variables

The CLI sets the run-scoped ones; a person or CI sets the rest. No other `CREDLESS_*` variable exists.

| Name | Set by | Meaning |
|---|---|---|
| `CREDLESS_TARGET` | CLI | the target name |
| `CREDLESS_SLOT` | CLI (`--slot`) | the slot letter |
| `CREDLESS_RUN_ID` | config (pinned once) | `^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$` |
| `CREDLESS_REPORT_DIR` | CLI | this run's evidence dir while live (in staging) |
| `CREDLESS_STAGING_DIR` | person or CI | the private staging dir |
| `CREDLESS_BROKER_URL`, `CREDLESS_BROKER_TOKEN` | global setup | for the workers; the token is worthless after the run |
| `CREDLESS_RUNNER_KEY` | CI or a person (the `env` key source) | the test-API key; the CLI takes it over and unsets it; never in a worker's environment |
| `CREDLESS_RUNNER_KEY_FILE` | CLI | the 0600 handover file; read once by global setup and deleted |
| `CREDLESS_SIGNIN_PASSWORD_FILE` | CLI | 0600 file in staging, read by the one sign-in test |
| `CREDLESS_SIGNIN_PASSWORD` | self-tests only | the demo's stand-in |
| `CREDLESS_EVIDENCE_KEY` | CLI (random per run) | HMAC key for the list of codes to mask; never written |
| `CREDLESS_SCRUB_VALUES_FILE` | CLI | NUL-separated values post-run scrubs; read once and deleted |
| `CREDLESS_WORKERS` | CLI (`--workers`) | worker count |
| `CREDLESS_TRACE` | person | `off`, `retain-on-failure`, `on` |
| `CREDLESS_GUARD_OUTSIDE` | person | `fail` (default) or `note` |
| `CREDLESS_A11Y` | person | `gate` makes serious and critical axe findings fail |
| `CREDLESS_WEB_URL`, `CREDLESS_API_URL` | person | origin overrides; same checks |

Nothing secret is ever passed as a CLI argument.
