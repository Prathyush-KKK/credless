/**
 * The shared interfaces every task of the kit codes against (plan §4 and §11, Task 0).
 *
 * Frozen by Task 0. A task that needs a change proposes a diff to Task 0's owner and never applies it unilaterally.
 * Everything here is erasable TypeScript (no enums, no parameter properties, no namespaces) so Node can strip it
 * without a transform, and every host rule is a string so a config is serialisable to workers and to the doctor.
 *
 * Conventions this file fixes in code (prose in docs/conventions.md): environment variable names ({@link ENV}),
 * exit codes ({@link EXIT}), header names and defaults ({@link DEFAULTS}), identifier shapes ({@link PATTERNS}),
 * the seven core routes ({@link CORE_ROUTES}), the evidence folder layout ({@link EVIDENCE}), private address
 * ranges ({@link PRIVATE_RANGES}) and egress limits ({@link EGRESS_LIMITS}).
 *
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BrowserContext, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { CANARY_HOST, ENV_PREFIX, KIT_NAME } from './brand.ts';

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every environment variable the kit reads or sets, derived from {@link ENV_PREFIX}. The runner sets the run-scoped
 * ones for Playwright's processes; workers never see `RUNNER_KEY` or `RUNNER_KEY_FILE` (global setup reads the file,
 * deletes it, starts the broker and removes both from the environment before any worker starts).
 */
export const ENV = {
  /** the target name (a key of `KitConfig.targets`) this run points at */
  TARGET: `${ENV_PREFIX}TARGET`,
  /** the agent slot letter (`PATTERNS.slot`) that keeps two agents' accounts apart; default `DEFAULTS.slot` */
  SLOT: `${ENV_PREFIX}SLOT`,
  /** the run id (`PATTERNS.runId`), pinned by the config so every worker shares it */
  RUN_ID: `${ENV_PREFIX}RUN_ID`,
  /** this run's evidence directory while it runs (inside the private staging dir); moved to `reports/<run id>` after post-run */
  REPORT_DIR: `${ENV_PREFIX}REPORT_DIR`,
  /** the private 0700 staging directory (default: the per-user cache dir, see docs/conventions.md) */
  STAGING_DIR: `${ENV_PREFIX}STAGING_DIR`,
  /** the loopback broker's URL (`http://127.0.0.1:<port>`), set by global setup for the workers */
  BROKER_URL: `${ENV_PREFIX}BROKER_URL`,
  /** the per-run broker token, set by global setup for the workers; worthless once the run ends */
  BROKER_TOKEN: `${ENV_PREFIX}BROKER_TOKEN`,
  /** the test-API runner key as the `env` key source reads it (CI passes it to the one `run` step only); the CLI takes it over and unsets it */
  RUNNER_KEY: `${ENV_PREFIX}RUNNER_KEY`,
  /** the 0600 file in staging the CLI hands the key over in; read once by global setup and deleted at once */
  RUNNER_KEY_FILE: `${ENV_PREFIX}RUNNER_KEY_FILE`,
  /** the sign-in persona's password in the environment: the self-tests' stand-in only; real runs use the file */
  SIGNIN_PASSWORD: `${ENV_PREFIX}SIGNIN_PASSWORD`,
  /** the 0600 file in staging holding the sign-in persona's password, for the one UI sign-in test */
  SIGNIN_PASSWORD_FILE: `${ENV_PREFIX}SIGNIN_PASSWORD_FILE`,
  /** random per run, held by the runner, never written: keys the HMAC list of codes the scrubber removes */
  EVIDENCE_KEY: `${ENV_PREFIX}EVIDENCE_KEY`,
  /** the NUL-separated 0600 file of secret values post-run scrubs by value; read once and deleted */
  SCRUB_VALUES_FILE: `${ENV_PREFIX}SCRUB_VALUES_FILE`,
  /** worker count override (`run --workers`) */
  WORKERS: `${ENV_PREFIX}WORKERS`,
  /** trace mode override: off | retain-on-failure | on */
  TRACE: `${ENV_PREFIX}TRACE`,
  /** what the guard does with an unlisted host: fail (default) | note */
  GUARD_OUTSIDE: `${ENV_PREFIX}GUARD_OUTSIDE`,
  /** `gate` makes serious and critical axe findings fail the test; otherwise they are evidence only */
  A11Y: `${ENV_PREFIX}A11Y`,
  /** override of the target's web origin; must pass the same checks as the configured one */
  WEB_URL: `${ENV_PREFIX}WEB_URL`,
  /** override of the target's api origin; must pass the same checks as the configured one */
  API_URL: `${ENV_PREFIX}API_URL`,
  /** the worker shim's policy: unset or `off` leaves it inert; `loopback` (set by global setup) lets a worker dial loopback only; a URL allows that proxy too */
  WORKER_PROXY_URL: `${ENV_PREFIX}WORKER_PROXY_URL`,
  /** the 0600 file holding the demo's stand-in runner key: the demo writes it (`--write-key`), the demo configs' `file` key source reads it */
  DEMO_KEY_FILE: `${ENV_PREFIX}DEMO_KEY_FILE`,
} as const;

/** The name of one kit environment variable, for example `'CREDLESS_TARGET'`. */
export type EnvName = (typeof ENV)[keyof typeof ENV];

/** CLI exit codes (plan §4.4). The GitHub Action exits with the same code. */
export const EXIT = {
  /** every test passed and the evidence is clean */
  PASS: 0,
  /** a test failed, or a secret value was found in the evidence (scrubbed, kept, and the run failed for it) */
  FAIL: 1,
  /** usage: unknown or production target, bad flag, missing tool, lock held, no key source */
  USAGE: 2,
  /** the evidence is not safe to keep (post-run failed or something secret-shaped survived); staging was deleted */
  EVIDENCE_UNSAFE: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Defaults every task uses when a config leaves the field out. */
export const DEFAULTS = {
  /** base path of the test API on the api origin */
  basePath: '/_test',
  /** header that carries the runner key to the test API (configurable: `testApi.keyHeader`) */
  keyHeader: 'X-Test-Runner-Key',
  /** header that carries the per-run token from a worker to the broker (not configurable) */
  brokerTokenHeader: 'X-Test-Broker-Token',
  /** `production.words`: a host with one of these as a label or label part is production, anywhere */
  productionWords: ['prod', 'production'],
  /** `personas.slot` */
  slot: 'a',
  /** `personas.workers` for a remote target */
  workers: 2,
  /** `evidence.reportsDir`, relative to the project */
  reportsDir: 'reports',
  /** `evidence.codeShape`: what the masks and the scrubber treat as a one-time code */
  codeShape: 'digits6',
  /** `evidence.trace` */
  trace: 'retain-on-failure',
  /** `hosts.outside` */
  outside: 'fail',
  /** the colour screenshots mask secrets with */
  maskColor: '#FF00FF',
  /** elements never shown in a screenshot, in addition to `evidence.maskSelectors` */
  alwaysMasked: 'input[type="password"], [data-sensitive]',
  /** the backend brief's recommended maximum session TTL for minted sessions, in seconds (T8) */
  sessionMaxAgeSeconds: 3600,
  /** how long post-run waits for a second run's evidence in `--twice`, in minutes */
  waitMinutes: 0,
  /** the canary host every new context must reach through its own proxy */
  canaryHost: CANARY_HOST,
  /** the per-user cache dir name under which staging lives (`~/.cache/<name>/staging`, `%LOCALAPPDATA%\<name>\staging`) */
  cacheDirName: KIT_NAME,
} as const;

/** The shapes of identifiers (docs/conventions.md, "Identifiers"). */
export const PATTERNS = {
  /** `20261008T101500Z-ab12`: UTC stamp plus four random base-36 characters */
  runId: /^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$/,
  /** one lowercase letter: the agent slot */
  slot: /^[a-z]$/,
  /** slot letter plus the worker's parallel index: `a0`, `b12` */
  namespace: /^[a-z][0-9]{1,2}$/,
  /** a persona id in the catalog: `owner`, `second-owner`; 1 to 24 characters, no trailing hyphen */
  personaId: /^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
  /** `<namespace>.<persona>`: the account handle the test API knows, for example `a0.owner` */
  handle: /^[a-z][0-9]{1,2}\.[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
  /** a six-digit one-time code (`evidence.codeShape: 'digits6'`) */
  code6: /^[0-9]{6}$/,
} as const;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One route of a test-API contract, relative to the base path. */
export interface RouteDef {
  method: HttpMethod;
  /** OpenAPI path with `{param}` placeholders, for example `/personas/{handle}` */
  path: string;
}

/** A route table keyed by operationId: the core routes, or core plus an app's extension routes. */
export type RouteTable = Readonly<Record<string, RouteDef>>;

/**
 * The seven core routes of contract/core.openapi.yaml (plan §4.5), relative to `testApi.basePath`. The client, the
 * broker's allowlist, the reference server and the contract check all read this table; the contract file is the
 * source of truth and `check:contract` fails when they differ.
 */
export const CORE_ROUTES = {
  health: { method: 'GET', path: '/health' },
  ensurePersonas: { method: 'POST', path: '/personas/ensure' },
  resetPersonas: { method: 'POST', path: '/personas/reset' },
  personaState: { method: 'GET', path: '/personas/{handle}' },
  createSession: { method: 'POST', path: '/session' },
  personaMessages: { method: 'GET', path: '/personas/{handle}/messages' },
  cleanupRun: { method: 'POST', path: '/runs/{runId}/cleanup' },
} as const satisfies Record<string, RouteDef>;

export type CoreOperationId = keyof typeof CORE_ROUTES;

/**
 * The evidence folder layout (plan §8): names under `reports/<run id>/`, moved there from staging only after
 * post-run wrote its marker. Shots are `shots/<case>--<persona>-<step>-<project>.png` (`-FAILED-` as the step for a
 * triage shot); aria snapshots are `aria/<case>--<persona>-<step>.yaml`.
 */
export const EVIDENCE = {
  summary: 'SUMMARY.md',
  coverage: 'COVERAGE.md',
  flakes: 'FLAKES.md',
  quarantined: 'QUARANTINED.md',
  run: 'run.json',
  suite: 'suite.json',
  scan: 'scan.json',
  contactSheets: 'contact-sheets',
  shots: 'shots',
  aria: 'aria',
  html: 'html',
  junit: 'junit.xml',
  results: 'results.json',
  ctrf: 'ctrf.json',
  blob: 'blob/report.zip',
  artifacts: 'artifacts',
  /** written last by post-run with the exit code; without it the folder is deleted, never kept */
  marker: '.post-run-done',
  /** HMACs (under `ENV.EVIDENCE_KEY`) of codes in play, appended by the test fixtures, deleted before the evidence is kept */
  sensitiveHashes: '.sensitive-hashes',
} as const;

/**
 * Address ranges the egress proxy refuses after resolving a host, unless the target's `kind` is `local`
 * (plan §6 T4). IPv4-mapped IPv6 forms of the v4 ranges are refused too.
 */
export const PRIVATE_RANGES: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** Resource caps of one egress proxy (plan §6 T4). */
export interface EgressLimits {
  /** request-line plus header bytes accepted before the proxy closes the client (16 KiB) */
  maxHeaderBytes: number;
  /** concurrent tunnels per proxy */
  maxTunnels: number;
  /** idle time before a tunnel is closed, in milliseconds */
  idleMs: number;
}

export const EGRESS_LIMITS: Readonly<EgressLimits> = { maxHeaderBytes: 16 * 1024, maxTunnels: 64, idleMs: 60_000 };

// ---------------------------------------------------------------------------------------------------------------
// Config (`<kit>.config.ts`, plan §4.1)
// ---------------------------------------------------------------------------------------------------------------

/** `local` targets may resolve to loopback and private ranges; `remote` ones (the default) may not. */
export type TargetKind = 'local' | 'remote';

/** One environment a run can point at: the web app's origin and the backend's origin. */
export interface Target {
  /** the web app's origin, for example `https://dev.app.example` */
  web: string;
  /** the backend's origin, for example `https://dev.api.example` */
  api: string;
  /** the origin that serves the test API when it is not `api` (default: `api`) */
  testApi?: string;
  /** default `remote` */
  kind?: TargetKind;
}

/**
 * Production detection (plan §4.1): a host with one of `words` as a label or label part is production anywhere;
 * a host on or under one of `domains` is production unless it is a target host or matches `nonProductionPattern`.
 * Production and the target hosts can never overlap; the loader refuses a config where they do.
 */
export interface ProductionConfig {
  /** the organisation's domains, for example `['example.com']` */
  domains: string[];
  /** default {@link DEFAULTS.productionWords} */
  words?: string[];
  /** a regular expression source matched against the whole hostname, for example `'^(dev|staging)-[a-z]+\\.example\\.com$'` */
  nonProductionPattern?: string;
}

/** A host rule: an exact hostname or a glob with a leading `*.` label, for example `'*.googleapis.com'`. */
export type HostGlob = string;

/** What the guard does with a request to a host nobody listed: fail the test, or only list it in the evidence. */
export type OutsideMode = 'fail' | 'note';

export interface HostsConfig {
  /** hosts the app loads at boot or on known screens: let through and listed per test */
  thirdParty?: HostGlob[];
  /** analytics hosts: aborted before they leave, listed, never failures */
  analytics?: HostGlob[];
  /** default {@link DEFAULTS.outside} */
  outside?: OutsideMode;
}

export interface PersonasConfig {
  /** path of the persona catalog YAML, relative to the config file */
  catalog: string;
  /**
   * a regular expression source every rendered address must match, for example `'^qa\\+[a-z0-9-]+@example\\.com$'`;
   * the test API enforces the same range on its side
   */
  addressPattern: string;
  /** default {@link DEFAULTS.slot}; the CLI's `--slot` overrides it */
  slot?: string;
  /** default {@link DEFAULTS.workers} */
  workers?: number;
}

export interface TestApiConfig {
  /** default {@link DEFAULTS.basePath} */
  basePath?: string;
  /** default {@link DEFAULTS.keyHeader} */
  keyHeader?: string;
  /** path of the app's extension contract (OpenAPI), merged with the core contract for the broker's allowlist */
  contract?: string;
  /** headers the client sends on every test-API call (device or client headers a backend filters on) */
  headers?: Record<string, string>;
}

/** Built-in `exec` presets: an argv template the CLI fills with `ref`, run with `execFile` (no shell). */
export type ExecPreset = 'op' | 'infisical' | 'doppler' | 'vault' | 'kubectl';

/**
 * Where the runner key comes from. `describe()` of the resulting source prints these fields; a value is read only
 * by `run`, never by `doctor`.
 */
export type KeySourceRef =
  | {
      source: 'env';
      /** default {@link ENV.RUNNER_KEY} */
      name?: string;
    }
  | {
      source: 'file';
      /** read once; must be mode 0600 on POSIX (advisory on Windows) */
      path: string;
    }
  | {
      source: 'exec';
      /** a full argv, no shell: `['op', 'read', 'op://vault/item/field']` */
      argv?: string[];
      /** alternatively a preset plus the reference it takes */
      preset?: ExecPreset;
      ref?: string;
    }
  | {
      source: 'keyring';
      /** OS keyring service and account (`@napi-rs/keyring`, optional dependency) */
      service: string;
      account: string;
    };

export type SessionProviderRef =
  | { provider: 'test-api' }
  | {
      provider: 'storage-state-file';
      /** a Playwright storage-state file per persona id: `<dir>/<persona>.json`; documented as the weaker option */
      dir: string;
    }
  | {
      provider: 'module';
      /** a module whose default export is a {@link SessionProvider} */
      module: string;
    };

export type MailSinkRef =
  | { sink: 'test-api' }
  | {
      sink: 'mailpit';
      /** the Mailpit UI/API origin, for example `http://127.0.0.1:8025` */
      url: string;
    }
  | {
      sink: 'module';
      /** a module whose default export is a {@link MailSink} */
      module: string;
    };

export interface ControlRef {
  /** a module whose default export is a class extending the kit's `Control` (plan §4.5, extension pattern) */
  module: string;
}

export type TraceMode = 'off' | 'retain-on-failure' | 'on';

export interface EvidenceConfig {
  /** where kept evidence goes: `<reportsDir>/<run id>/`; default {@link DEFAULTS.reportsDir} */
  reportsDir?: string;
  /** the private 0700 staging dir; default: the per-user cache dir (docs/conventions.md) */
  stagingDir?: string;
  /** a selector for the app's boot cover (splash, skeleton); shots wait until it is gone */
  bootCover?: string;
  /** selectors masked in every screenshot, in addition to {@link DEFAULTS.alwaysMasked} */
  maskSelectors?: string[];
  /** `digits6` (default) or a regular expression source for what counts as a one-time code */
  codeShape?: 'digits6' | string;
  /** default {@link DEFAULTS.trace} */
  trace?: TraceMode;
  /** keep traces of passed tests too (default false) */
  retainOnPass?: boolean;
}

/** Becomes a Playwright project: `use` is passed through to `TestProject.use`. */
export interface BrowserProjectConfig {
  name: string;
  use: Record<string, unknown>;
  /** free-form, for the contact sheets (`size`, `theme`) */
  metadata?: Record<string, string>;
}

export interface DockerConfig {
  /** the Playwright image, pinned by digest in the runner; a different tag here is refused by `doctor` unless it is pinned */
  image?: string;
  /** v0.2: run with no route to the network except the sidecar egress proxy */
  isolate?: boolean;
}

/** The config file's shape (`defineConfig` validates it with zod and returns it). */
export interface KitConfig {
  targets: Record<string, Target>;
  production: ProductionConfig;
  hosts?: HostsConfig;
  personas: PersonasConfig;
  testApi?: TestApiConfig;
  key: KeySourceRef;
  /** default `{ provider: 'test-api' }` */
  session?: SessionProviderRef;
  control?: ControlRef;
  /** default `{ sink: 'test-api' }` */
  mail?: MailSinkRef;
  signals?: Partial<AppSignals>;
  evidence?: EvidenceConfig;
  browsers?: BrowserProjectConfig[];
  docker?: DockerConfig;
}

/**
 * The loaded, per-run form of the config (port of the private `QaConfig`): what the fixtures, the guard and
 * post-run read. Built by the config loader from {@link KitConfig} plus the run's environment; throws on anything
 * unsafe (a production host, a bad run id or slot, an unknown target).
 */
export interface RunConfig {
  /** the key of `KitConfig.targets` this run points at */
  target: string;
  /** the resolved origins, trailing slashes removed, overrides applied and checked */
  endpoints: Required<Pick<Target, 'web' | 'api' | 'testApi' | 'kind'>>;
  runId: string;
  slot: string;
  /** this run's evidence directory (in staging while the run is live) */
  reportDir: string;
  /** the private 0700 staging directory */
  stagingDir: string;
  /** the validated config with defaults filled in */
  kit: KitConfig;
  /** hostnames of the target origins, exempt from the production domain rule */
  targetHosts: string[];
  /** whether the config names a key source (the value itself never leaves the key source and the broker) */
  hasKeySource: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Persona catalog (personas.yaml)
// ---------------------------------------------------------------------------------------------------------------

/** How a persona signs in: `session` through the test API (the default), `password` through the UI only. */
export type PersonaAuth = 'session' | 'password';

export interface PersonaDefaults {
  locale: string;
  timezone: string;
  countryCode?: string;
  auth: PersonaAuth;
}

/**
 * One catalog entry: a role, not an account. The runner creates one account per persona per namespace, so parallel
 * workers and agents never share a login. First names must be unique in a catalog, so screenshots tell people apart.
 */
export interface CatalogEntry {
  /** the app role the persona plays (`owner`, `member`, `guest`); free-form, the app's test API interprets it */
  role: string;
  firstName: string;
  auth?: PersonaAuth;
  locale?: string;
  timezone?: string;
  countryCode?: string;
  /** app-specific attributes the test API receives in `PersonaSpec.attributes` (a plan, flags, ...) */
  attributes?: Record<string, unknown>;
  /** what the persona is for, for people and agents reading the catalog */
  purpose: string;
  /** the documents or case lists that use it */
  usedBy?: string[];
}

/** A catalog address that is deliberately NOT an account (an invited address nobody answers for). */
export interface CatalogAddress {
  /** must contain `{ns}` and render inside `personas.addressPattern` */
  template: string;
  purpose: string;
}

export interface Catalog {
  version: 1;
  status?: 'draft' | 'confirmed';
  /** must contain `{ns}` and `{persona}` and render inside `personas.addressPattern`, for example `qa+{ns}-{persona}@example.com` */
  addressTemplate: string;
  /** must contain `{ns}`, for example `QA-{ns}` */
  lastNameTemplate: string;
  defaults: PersonaDefaults;
  /** keyed by persona id ({@link PATTERNS.personaId}) */
  personas: Record<string, CatalogEntry>;
  addresses?: Record<string, CatalogAddress>;
}

/** One persona in one namespace: an account on the target (the resolved form of a catalog entry). */
export interface Persona {
  /** catalog id, for example `owner` */
  id: string;
  /** namespace, for example `a0` */
  ns: string;
  /** the account handle the test API knows, for example `a0.owner` */
  handle: string;
  email: string;
  firstName: string;
  lastName: string;
  /** `firstName lastName`, how the app shows the person */
  displayName: string;
  role: string;
  auth: PersonaAuth;
  locale: string;
  timezone: string;
  countryCode?: string;
  attributes: Record<string, unknown>;
}

/**
 * What `ensurePersonas` sends per persona (contract `PersonaSpec`). `attributes` carries the well-known keys
 * `role`, `firstName`, `lastName`, `locale`, `timezone`, `countryCode`, `auth` plus the catalog entry's own.
 */
export interface PersonaSpec {
  handle: string;
  email: string;
  displayName: string;
  attributes: Record<string, unknown>;
}

/** What `ensurePersonas` answers per persona. */
export interface PersonaRef {
  handle: string;
  /** the backend's id for the account, opaque to the kit (string, never a number) */
  userId: string;
  created: boolean;
}

/** What `personaState` answers: the backend's view of one account, app-defined under `state`. */
export interface PersonaState {
  handle: string;
  userId: string;
  state: Record<string, unknown>;
}

/** What `resetPersonas` answers per handle: how many of each kind of object the reset removed. */
export interface ResetResult {
  handle: string;
  removed: Record<string, number>;
}

/** What `cleanupRun` answers. */
export interface CleanupResult {
  /** objects removed per kind, for example `{ workspaces: 2, documents: 5 }` */
  removed: Record<string, number>;
  /** sessions minted under the run id that were revoked */
  sessionsRevoked: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------

/**
 * A value that must never be printed. `reveal()` is the only way to read it, called on purpose in the one place
 * that sends it. The kit's `Secret` class (core/secret.ts, Task 1) implements it so that `String(s)`, `${s}`,
 * `JSON.stringify(s)` and `util.inspect(s)` all say `[redacted]`, and registers the value with the redactor so any
 * text that leaves the process has it replaced. Adapters and app controls return this, never a string.
 */
export interface SecretValue {
  /** what the value is, for messages: `runner key`, `workspace 12 code`, `sign-in password` */
  readonly label: string;
  reveal(): string;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and cookies
// ---------------------------------------------------------------------------------------------------------------

/** A cookie as `BrowserContext.addCookies` takes it (port of the private `BrowserCookie`). */
export interface BrowserCookie {
  name: string;
  value: string;
  /** host-only cookies carry the bare host; domain cookies a leading dot. `narrowCookies` makes every cookie host-only on the run's hosts */
  domain: string;
  path: string;
  /** epoch seconds; -1 for a session cookie */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** Playwright's storage state in its object form (cookies and origins). */
export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

export interface SessionUser {
  userId: string;
  email: string;
  displayName?: string;
}

/** What a {@link SessionProvider} mints: cookies and/or a storage state to inject into the persona's context. */
export interface SessionGrant {
  cookies?: BrowserCookie[];
  storageState?: StorageState;
  /** epoch seconds */
  expiresAt: number;
  user?: SessionUser;
}

// ---------------------------------------------------------------------------------------------------------------
// Test-API client, broker and contract payloads
// ---------------------------------------------------------------------------------------------------------------

/** The error body every test-API refusal carries (plan §4.5): HTTP status plus `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error: {
    /** a stable machine-readable code, for example `bad-key`, `not-test-account`, `invalid`, `rate-limited` */
    code: string;
    message: string;
  };
}

/** Contract `Health`: what `GET /health` answers. */
export interface Health {
  enabled: true;
  /** the backend's name for the environment, for example `dev` */
  environment: string;
  /** first 8 hex of SHA-256 of the key that was presented; never the key */
  keyId: string;
  version?: string;
  /** sinks the backend has wired for test accounts (mail captured, pushes logged, analytics skipped); a `false` fails a real run */
  sinks: Record<string, boolean>;
  /** operationIds of the app extension routes this backend implements */
  extensions: string[];
}

/** Contract `Message` as it travels: codes are plain strings on the wire. */
export interface WireMessage {
  id: string;
  to: string;
  subject: string;
  /** epoch seconds */
  sentAt: number;
  links: string[];
  /** one-time codes parsed out of the body */
  codes: string[];
  /** the app's own classification (`invite`, `auth`, ...) */
  kind?: string;
}

/** A captured message as tests see it: codes wrapped so they cannot be printed, and registered for masking. */
export interface Message extends Omit<WireMessage, 'codes'> {
  codes: SecretValue[];
}

/** Contract request of `POST /session`. */
export interface CreateSessionRequest {
  handle: string;
  runId: string;
  /** which client the session is for, when the backend issues different cookies per client (default `web`) */
  client?: string;
}

/** Contract response body of `POST /session` (the cookies travel in `Set-Cookie`). */
export interface CreateSessionResponse {
  user: Required<SessionUser>;
  /** epoch seconds; the brief recommends at most {@link DEFAULTS.sessionMaxAgeSeconds} */
  expiresAt: number;
}

/** Contract request of `POST /runs/{runId}/cleanup`. */
export interface CleanupRunRequest {
  /** default true */
  revokeSessions?: boolean;
}

/** How calls reach the test API: `direct` sends the key itself (the runner's own process only); `broker` goes through the loopback broker with the per-run token. */
export type Transport = { kind: 'direct'; key: SecretValue } | { kind: 'broker'; url: string; token: SecretValue };

export interface CallRequest {
  /** fills `{param}` placeholders; values are URL-encoded */
  params?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CallResult<T> {
  http: number;
  data: T;
  /** raw `Set-Cookie` values (session route); every cookie value is registered as a secret before this returns */
  setCookies: string[];
}

/** One line of the client's call log: method, path, status and time only, never a header or a body. */
export interface CallLogEntry {
  at: string;
  method: HttpMethod;
  path: string;
  status: number | 'error';
  ms: number;
}

/** The low-level test-API client (core/test-api-client.ts, Task 1). Only it puts the key or the token on the wire. */
export interface TestApiClient {
  readonly apiOrigin: string;
  readonly basePath: string;
  readonly routes: RouteTable;
  readonly log: readonly CallLogEntry[];
  /** throws a {@link TestApiError} on any non-2xx; never follows redirects */
  call<T = unknown>(operationId: string, request?: CallRequest): Promise<CallResult<T>>;
}

/** The error the client throws: rebuilt from scratch and redacted, so no header or body can ride along. */
export interface TestApiError extends Error {
  readonly name: 'TestApiError';
  readonly operationId: string;
  readonly http: number;
  /** `error.code` from the body when there was one */
  readonly code: string | null;
  /** HTTP 404: the object is gone, or the route does not exist (the test API is off on this target) */
  readonly notFound: boolean;
}

export interface BrokerOptions {
  /** the origin the broker forwards to (`endpoints.testApi`) */
  apiOrigin: string;
  key: SecretValue;
  keyHeader: string;
  /** core routes plus the app's extension routes: anything else is 404 at the broker */
  routes: RouteTable;
  basePath: string;
  /** request headers the broker forwards (content negotiation plus `testApi.headers` names); everything else is dropped */
  forwardHeaders: string[];
  upstreamTimeoutMs?: number;
}

/** The run's loopback broker: the only process-local place that holds the runner key during a run. */
export interface Broker {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly token: SecretValue;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Adapters (`<kit>/adapters`, plan §4.2)
// ---------------------------------------------------------------------------------------------------------------

/** Mints a signed-in session for a persona. Built-ins: `test-api` (the default) and `storage-state-file`. */
export interface SessionProvider {
  name: string;
  mint(persona: Persona, ctx: { api: TestApiClient; runId: string }): Promise<SessionGrant>;
  /** v0.2: tells whether the context's session is still valid, so the fixture can re-mint on expiry */
  verify?(context: BrowserContext): Promise<boolean>;
}

export interface MailQuery {
  /** epoch seconds */
  since?: number;
  kind?: string;
  limit?: number;
}

export type MailMatch = RegExp | ((message: Message) => boolean);

export interface MailWaitOptions extends MailQuery {
  /** default 20 000 */
  timeoutMs?: number;
}

/** Reads what the backend sent a persona. Built-ins: `test-api` (the default) and `mailpit`. */
export interface MailSink {
  name: string;
  messages(address: string, query?: MailQuery): Promise<Message[]>;
  waitFor(address: string, match: MailMatch, options?: MailWaitOptions): Promise<Message>;
}

/** Where the runner key comes from. `describe()` never runs anything and never reads a value (the doctor prints it). */
export interface KeySource {
  name: string;
  describe(): string;
  read(): Promise<SecretValue>;
}

/** What the guard and the session helpers hand to {@link AppSignals}. */
export interface SignalInput {
  url: URL;
  status: number;
  /** the parsed JSON body when the response was JSON */
  json?: unknown;
}

/**
 * How the app signals things the kit must recognise. Defaults: `unexpectedSignOut` is a 401 on the api origin,
 * `apiError` is any status >= 400. An app whose API wraps errors in an envelope with HTTP 200 overrides both.
 */
export interface AppSignals {
  /** cookie names the scrubber and `narrowCookies` treat as sessions */
  sessionCookies: string[];
  unexpectedSignOut(r: SignalInput): boolean;
  /** the app-level error code of a response (its status, or an envelope code), or null when it is not an error */
  apiError(r: SignalInput): number | null;
  /** a double-submit CSRF pair, so `session.api()` can send mutations like the app does */
  csrf?: { cookie: string; header: string };
  bootCover?: string;
}

/** What the kit's `Control` takes; an app's extension class passes it through to `super`. */
export interface ControlOptions {
  api: TestApiClient;
  catalog: Catalog;
  ns: string;
  runId: string;
  webOrigin: string;
  mail: MailSink;
  /** told about every secret the control API hands out (codes), so screenshots can mask it */
  onSecret?: (secret: SecretValue) => void;
}

/**
 * The core state control (plan §4.2): what every app gets. Tests use persona ids (`owner`); the control maps them to
 * the worker's handles (`a0.owner`) and remembers what it created and touched so teardown can undo it even when the
 * test failed. Apps extend the class with their own methods (plan §4.5, extension pattern) and reach the protected
 * helpers in {@link ControlInternals}.
 */
export interface StateControl {
  readonly ns: string;
  readonly runId: string;
  /** personas whose server state a test touched (teardown resets them) */
  readonly touched: Set<string>;
  /** objects this instance created and has not removed, kind to ids (teardown removes them in reverse order) */
  readonly created: Map<string, Set<string>>;
  health(): Promise<Health>;
  ensure(ids: string[]): Promise<PersonaRef[]>;
  reset(ids: string[]): Promise<void>;
  state(id: string): Promise<PersonaState>;
  persona(id: string): Persona;
  /** handle (`a0.owner`) for a persona id */
  handle(id: string): string;
  /** a persona id or a catalog address name to an email address in this namespace */
  address(to: string): string;
  /** mail the sink captured for a persona id or address name, newest first */
  messages(to: string, query?: MailQuery): Promise<Message[]>;
  waitForMessage(to: string, match: MailMatch, options?: MailWaitOptions): Promise<Message>;
  /** remove everything created, then reset every persona touched; returns the problems, never throws; safe to call twice */
  teardown(): Promise<string[]>;
  cleanupRun(): Promise<CleanupResult>;
}

/**
 * The protected surface an app's extension class uses (`this.api`, `this.track(...)`, `this.secret(...)`).
 * Documentation only: a class cannot `implements` protected members, so `Control` mirrors these as protected fields.
 */
export interface ControlInternals {
  readonly api: TestApiClient;
  /** remember an object for teardown; `kind` names the extension's delete method or cleanup bucket */
  track(kind: string, id: string): void;
  untrack(kind: string, id: string): void;
  /** wrap a value the backend handed out (an invite code), register it for masking and scrubbing */
  secret(value: string, label: string): SecretValue;
  /** map persona ids to handles in a request spec: strings that are persona ids, and arrays and record keys of them */
  handles<T>(spec: T): T;
}

// ---------------------------------------------------------------------------------------------------------------
// Guard and egress (fixtures/guard.ts, fixtures/egress.ts, Task 2)
// ---------------------------------------------------------------------------------------------------------------

/** The run-wide knobs the `guard` fixture exposes; applied to every session opened in the test. */
export interface GuardKnobs {
  /** an HTTP error status this test expects for matching URLs (with the reason in the test title) */
  expectStatus(url: RegExp, status: number): void;
  /** an app-level error code ({@link AppSignals.apiError}) this test expects for matching URLs */
  expectSignal(url: RegExp, code: number): void;
  /** a console error this test expects; the reason is required */
  allowConsole(pattern: RegExp, reason: string): void;
}

/** The names of the per-persona lists the fixture attaches as `<persona>-<list>` text attachments. */
export type GuardListName = 'outside' | 'third-party' | 'dev-hosts' | 'analytics-blocked' | 'api-errors' | 'cancelled';

/**
 * The guard one persona's browser context runs under. It fails the test on a console error, a page error, a failed
 * request, an HTTP error from the app or the API, an unexpected sign-out, any request to production and any request
 * to a host nobody listed; it lists third-party, dev and analytics traffic; the egress proxy's refusals are judged
 * here like refused requests.
 */
export interface Guard extends GuardKnobs {
  /** whose browser this is, for messages: the handle */
  readonly label: string;
  readonly violations: readonly string[];
  /** unlisted outside requests (when outside is `note`) */
  readonly outside: readonly string[];
  readonly thirdParty: readonly string[];
  /** non-production hosts of the organisation that are not the run's own (`nonProductionPattern`): let through, listed */
  readonly devHosts: readonly string[];
  readonly analyticsBlocked: readonly string[];
  /** API answers whose app-level code was an error (not failures unless a sign-out or unexpected) */
  readonly apiErrors: readonly string[];
  /** requests a navigation cancelled while in flight (listed, not failures) */
  readonly cancelled: readonly string[];
  /** true once this context's own proxy answered the canary request */
  readonly canarySeen: boolean;
}

/**
 * The proxy's decision for one host and port, in the order it is checked. `prod` is checked first and never let
 * through; `own`, `third-party` and `dev` pass; `analytics` and `outside` are refused (listed, or a violation);
 * `private` is a resolved address in {@link PRIVATE_RANGES} on a remote target; `canary` is answered by the proxy
 * itself with 204 and recorded, never dialled.
 */
export type EgressVerdict = 'own' | 'third-party' | 'analytics' | 'dev' | 'prod' | 'outside' | 'private' | 'canary';

export const EGRESS_PASSES: ReadonlySet<EgressVerdict> = new Set<EgressVerdict>(['own', 'third-party', 'dev']);

/** The policy a proxy judges by. Strings only, so it can be built in the main process and handed to workers. */
export interface EgressPolicy {
  /** `host:port` of the run's own origins, for example `dev.app.example:443` */
  own: string[];
  thirdParty: HostGlob[];
  analytics: HostGlob[];
  production: ProductionConfig;
  /** hostnames of the target origins, exempt from the production domain rule */
  targetHosts: string[];
  /** true for a `local` target: loopback and private addresses may be dialled */
  allowPrivate: boolean;
  /** default {@link DEFAULTS.canaryHost} */
  canaryHost?: string;
}

/** One resolved address, as `dns.lookup(host, { all: true })` returns it. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable resolver, so a unit test can feed a rebinding answer (public first, loopback second) and assert the dialled address. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** which browser context this proxy serves; the canary records it. Generated (`ctx-<random>`) when absent */
  contextId?: string;
  lookup?: HostResolver;
  limits?: Partial<EgressLimits>;
}

export interface EgressRefusal {
  verdict: EgressVerdict;
  /** what was refused, for example `CONNECT www.example.com:443` or `GET http://host/path` (no query, no header) */
  line: string;
  contextId: string;
}

/** One persona context's loopback proxy: judge before DNS, resolve once, refuse private ranges, pin the address. */
export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for the context's `proxy.server` */
  readonly url: string;
  readonly contextId: string;
  readonly refused: readonly EgressRefusal[];
  readonly canarySeen: boolean;
  onRefused(listener: (refusal: EgressRefusal) => void): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures (`<kit>`, plan §4.3)
// ---------------------------------------------------------------------------------------------------------------

export interface ShotOptions {
  /** more elements to mask */
  mask?: Locator[];
  /** a full-page screenshot instead of the viewport */
  fullPage?: boolean;
  /** a triage screenshot of a failed test: no wait for the boot cover (the page may be in any state) */
  triage?: boolean;
}

export interface A11yFinding {
  id: string;
  impact: string;
  help: string;
  nodes: number;
}

export interface PersonaApiOptions {
  method?: HttpMethod;
  data?: unknown;
  headers?: Record<string, string>;
}

/** The answer of `session.api()`: never throws on an error status, so a test can assert on it. */
export interface PersonaApiResponse<T = unknown> {
  http: number;
  /** the parsed JSON body, or null */
  data: T | null;
  /** the app-level error code ({@link AppSignals.apiError}), or null */
  signal: number | null;
}

/** One persona's browser: its own context, cookies, guard and egress proxy, signed in through the session provider. */
export interface PersonaSession {
  readonly persona: Persona;
  /** persona id, for example `owner` */
  readonly id: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guard: Guard;
  /** paths of the screenshots this session saved */
  readonly shots: readonly string[];
  readonly a11yFindings: ReadonlyArray<{ step: string; findings: A11yFinding[] }>;
  /** has this browser shown a screen of the app? (a passed test that opened a screen must have a shot) */
  readonly openedScreen: boolean;
  goto(path: string): Promise<void>;
  /** the screenshot of the screen this persona just checked: waits for the boot cover, masks codes and password fields; returns the path */
  shot(step?: string, options?: ShotOptions): Promise<string>;
  /** call the api origin as this persona, with the browser's cookies, `maxRedirects: 0`; api origin only */
  api<T = unknown>(path: string, options?: PersonaApiOptions): Promise<PersonaApiResponse<T>>;
  /** axe, WCAG 2.1 A and AA; findings are evidence, and failures only under `ENV.A11Y=gate` */
  a11y(step?: string): Promise<A11yFinding[]>;
  /** writes `page.ariaSnapshot()` to `aria/` as agent-readable, scrubbable text; returns the path */
  aria(step?: string): Promise<string>;
}

/** The `personas` fixture. */
export interface Personas {
  /** one signed-in browser per persona, in the order given: `const [owner, member] = await personas.open('owner', 'member')` */
  open<const T extends readonly string[]>(...ids: T): Promise<{ [K in keyof T]: PersonaSession }>;
  /** a browser for a persona with no session: landing pages, and the sign-in screens themselves */
  openSignedOut(id: string): Promise<PersonaSession>;
  persona(id: string): Persona;
  /** a catalog address that is not an account, in this namespace */
  address(name: string): string;
  /** every session opened in this test */
  readonly sessions: readonly PersonaSession[];
}

/** Codes in play in one test (from the control API, from mail): masked in every shot and listed for the scrubber. */
export interface SensitiveText {
  add(secret: SecretValue | null | undefined): void;
  /** locators for every element on the page showing a code in play */
  locators(page: Page): Locator[];
  /** the codes without spaces, for matching typed values */
  readonly plain: string[];
  readonly size: number;
}

/** The `shot` fixture: the fixture form of `session.shot()`, with the test's masks. */
export type ShotFn = (session: PersonaSession, step?: string, options?: ShotOptions) => Promise<string>;

/** The per-worker fixture `kit`: the run's config, this worker's namespace, its client and the ensured accounts. */
export interface KitWorker {
  config: RunConfig;
  catalog: Catalog;
  /** this worker's namespace, for example `a0` */
  ns: string;
  api: TestApiClient;
  health: Health;
  /** userId per persona id, from `ensurePersonas` */
  userIds: Map<string, string>;
}

/**
 * The fixture names (docs/conventions.md, "Fixtures"). `control` is widened to the app's extension class through
 * `config.control.module`; the exported `test` is `TestType<KitTestFixtures<C>, KitWorkerFixtures>`.
 */
export interface KitTestFixtures<C extends StateControl = StateControl> {
  personas: Personas;
  control: C;
  guard: GuardKnobs;
  shot: ShotFn;
  sensitive: SensitiveText;
}

export interface KitWorkerFixtures {
  kit: KitWorker;
}

// ---------------------------------------------------------------------------------------------------------------
// Reference server (`<kit>/server`, plan §5)
// ---------------------------------------------------------------------------------------------------------------

/** What a backend's session seam gives the reference server for one minted session. */
export interface MintedSession {
  /** full `Set-Cookie` header values, as the app's own login would send them */
  setCookies: string[];
  user: Required<SessionUser>;
  /** epoch seconds */
  expiresAt: number;
}

/** What `createTestApi` takes: the app's state behind the seven routes, nothing about HTTP. */
export interface TestApiServerOptions {
  /** the runner key the backend holds; compared in constant time */
  key: SecretValue | string;
  /** default {@link DEFAULTS.basePath} */
  basePath?: string;
  /** default {@link DEFAULTS.keyHeader} */
  keyHeader?: string;
  environment: string;
  version?: string;
  sinks?: Record<string, boolean>;
  /** operationIds of the app's extension routes, reported in health */
  extensions?: string[];
  /** addresses outside this pattern are refused with 403 */
  addressPattern: RegExp;
  personas: {
    ensure(specs: PersonaSpec[]): Promise<PersonaRef[]>;
    reset(handles: string[]): Promise<ResetResult[]>;
    /** null when the handle is unknown (404) */
    state(handle: string): Promise<PersonaState | null>;
  };
  session: {
    mint(request: CreateSessionRequest): Promise<MintedSession>;
    /** revoke every session minted under the run; returns how many */
    revoke(runId: string): Promise<number>;
  };
  mail: {
    list(handle: string, query: MailQuery): Promise<WireMessage[]>;
  };
  /** remove everything tagged with the run id; returns counts per kind */
  cleanup(runId: string): Promise<Record<string, number>>;
  /** the test-account flag (lock 4 of the brief); default: every handle the store knows */
  isTestAccount?(handle: string): Promise<boolean>;
}

/** The handler `createTestApi` returns: answers requests under the base path and returns true; false means not ours. */
export type TestApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// ---------------------------------------------------------------------------------------------------------------
// Evidence and reporting (plan §8)
// ---------------------------------------------------------------------------------------------------------------

/** `run.json`: the run's metadata, written by global setup and completed by teardown and post-run. No secrets. */
export interface RunMeta {
  runId: string;
  target: string;
  endpoints: RunConfig['endpoints'];
  slot: string;
  startedAt: string;
  finishedAt?: string;
  kit: { name: string; version: string };
  node: string;
  playwright?: string;
  git?: { sha: string | null; branch: string | null; dirty: boolean };
  catalog?: { status?: string; sha256: string };
  health?: Omit<Health, 'enabled'>;
  cleanup?: CleanupResult | { error: string };
  /** the exit code post-run decided on */
  exitCode?: ExitCode;
}

/** `suite.json`: Playwright's own exit code, kept apart from post-run's verdict. */
export interface SuiteResult {
  exitCode: number;
}

/** One scan hit: the file and the kind of thing found, never the value. */
export interface ScanFinding {
  file: string;
  /** `secret-value` (a registered value), `jwt`, `credential-header`, `cookie-value`, `code`, or an app-defined kind */
  kind: string;
  count: number;
}

/** `scan.json`. */
export interface ScanResult {
  at: string;
  scannedFiles: number;
  findings: number;
  files: ScanFinding[];
  /** files deleted and listed in QUARANTINED.md because a finding survived the scrub */
  quarantined: string[];
  /** findings of the second scan, after the quarantine; any entry makes the evidence unsafe to keep (scan.json only) */
  leftAfterRemoval?: ScanFinding[];
  /** registered secret values the scrub found and redacted; any number above 0 fails the run (scan.json only) */
  secretValues?: number;
  /** the files they were in, as top-level paths, never values (scan.json only) */
  secretValuesIn?: string[];
}

/**
 * What the scrub did. `scrubDir` returns it with one more, NON-ENUMERABLE member: `collected`, the cookie and header
 * values it gathered for the scan; a logged or serialised result never shows them.
 */
export interface ScrubResult {
  /** values redacted, all encodings counted */
  replaced: number;
  /** a registered secret VALUE was present: where and how often (the run fails for it) */
  secretValues: Array<{ where: string; count: number }>;
  /** cookie values collected from headers, handed to the scan */
  cookieValues: number;
  problems: string[];
}

/** The run's verdict as SUMMARY.md states it. */
export type RunVerdict = 'pass' | 'fail' | 'unsafe';

export type TestOutcome = 'passed' | 'failed' | 'flaky' | 'skipped' | 'expected-failure';

export interface SummaryTotals {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  expectedFailures: number;
}

export interface SummaryFailure {
  title: string;
  project: string;
  /** the triage shot, when there is one */
  shot?: string;
}

/** One row of COVERAGE.md, from `about(source, expected)` annotations. */
export interface CoverageRow {
  source: string;
  expected: string;
  test: string;
  outcomes: Record<string, TestOutcome>;
}

/** FLAKES.md: the comparison of a `--twice` run's two halves (blob reports merged with `merge-reports`). */
export interface FlakeReport {
  compared: [string, string];
  /** different outcome between the two runs */
  flaky: string[];
  onlyFirst: string[];
  onlySecond: string[];
}

/** What SUMMARY.md is rendered from (and the Action's PR comment). */
export interface Summary {
  runId: string;
  target: string;
  verdict: RunVerdict;
  exitCode: ExitCode;
  totals: SummaryTotals;
  failures: SummaryFailure[];
  scan: 'clean' | 'findings' | 'not-run';
  /** secret values found and scrubbed (any number above 0 fails the run) */
  leaked: number;
  quarantined: number;
  contactSheets: string[];
  flakes?: FlakeReport;
  durationMs: number;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI (plan §4.4)
// ---------------------------------------------------------------------------------------------------------------

export type CliCommand =
  | 'init'
  | 'doctor'
  | 'run'
  | 'health'
  | 'seed'
  | 'report'
  | 'evidence'
  | 'check-tests'
  | 'demo'
  | 'mcp';

export type RunMode = 'docker' | 'native';

export interface RunOptions {
  target: string;
  slot?: string;
  workers?: number;
  /** run the suite twice and compare (FLAKES.md) */
  twice?: boolean;
  mode?: RunMode;
  /** v0.2, docker mode only */
  isolate?: boolean;
  project?: string;
  /** minutes to wait for the target+slot lock */
  waitMinutes?: number;
  /** passed through to `playwright test` after `--` */
  playwrightArgs?: string[];
}

export interface DoctorOptions {
  target?: string;
  offline?: boolean;
  /** print the active security layers (plan §6 F11) */
  security?: boolean;
}

/** Options the kit's Playwright reporter takes (reporter/index.ts, v0.2). */
export interface KitReporterOptions {
  outputDir?: string;
  /** emit ctrf.json through the optional CTRF reporter when it is installed */
  ctrf?: boolean;
}
