// The Playwright fixtures every kit test uses (plan §4.3):
//
//   personas   open('owner', 'member') -> one signed-in browser per persona (its own context, cookies, guard and
//              egress proxy, the canary checked); openSignedOut(id) for the sign-in screens themselves
//   control    the app's state control: the kit's core plus the app's extension class (config.control.module)
//   guard      run-wide knobs applied to every session opened in the test
//   shot       the fixture form of session.shot()
//   sensitive  codes in play, masked in every shot
//
// Per worker (`kit`): the run's config, a namespace (a0, a1, ...) so parallel workers never share an account, a
// health check of the test API through the broker and the persona accounts for that namespace. Per test:
// everything a test created is closed and every persona it touched is reset, even when the test failed, and the
// guard's violations fail the test.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type BrowserContextOptions,
  test as base,
  expect,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo,
  type TestType,
} from '@playwright/test';
import { loadMailSink } from '../adapters/mail/index.ts';
import { loadSessionProvider } from '../adapters/session/index.ts';
import { defaultSignals } from '../adapters/signals.ts';
import { CLI_NAME, KIT_NAME } from '../brand.ts';
import { importKitConfig, loadRunConfig } from '../config/load.ts';
import { handleForAddress, loadCatalog, namespaceFor, personaIdOf } from '../core/catalog.ts';
import { Control } from '../core/control.ts';
import { loadContractRoutes, mergeRoutes } from '../core/routes.ts';
import { redact, Secret } from '../core/secret.ts';
import { narrowCookies } from '../core/session.ts';
import { TestApiClient as TestApiHttpClient } from '../core/test-api-client.ts';
import {
  type Catalog,
  CORE_ROUTES,
  type ControlOptions,
  DEFAULTS,
  ENV,
  type GuardKnobs,
  type GuardListName,
  type HostResolver,
  type KitTestFixtures,
  type KitWorkerFixtures,
  type OutsideMode,
  type Persona,
  type Personas,
  type RouteTable,
  type RunConfig,
  type SecretValue,
  type SessionGrant,
  type StateControl,
  type TestApiClient,
} from '../types.ts';
import { egressPolicyFor, type KitEgressProxy, startEgressProxy } from './egress.ts';
import { SensitiveText, shotPath, takeShot } from './evidence.ts';
import { attachGuard, GuardKnobStore } from './guard.ts';
import { PersonaSession } from './persona-session.ts';

/** Options the kit's own self-tests set with `test.use()`; a real suite never does. */
export interface KitSelfTestOptions {
  /** a resolver the persona proxies use instead of DNS; honoured on `local` targets only (self-test G13) */
  egressLookup: { lookup: HostResolver } | undefined;
}

type ControlClass = new (options: ControlOptions) => StateControl;

const PROXY_ARGS = /^--(proxy-server|proxy-bypass-list|host-resolver-rules)(=|$)/;
const CONFIG_FILES = ['ts', 'mts', 'js', 'mjs'].map((ext) => `${KIT_NAME}.config.${ext}`);

/**
 * T5: nothing may replace the per-context egress proxy. Checked on the project's `use` when the worker starts and
 * on the live options (which see `test.use()`) before any context opens.
 */
function assertNoProxyOverride(use: { proxy?: unknown; launchOptions?: { args?: string[] } }, where: string): void {
  if (use.proxy !== undefined) {
    throw new Error(
      `egress proxy bypassed: ${where} sets proxy; every persona context gets its own egress proxy and nothing may replace it`,
    );
  }
  const arg = use.launchOptions?.args?.find((a) => PROXY_ARGS.test(a));
  if (arg)
    throw new Error(
      `egress proxy bypassed: ${where} launches the browser with ${arg}; the per-context proxy is the only proxy`,
    );
}

/** The run's config: `<kit>.config.*` in the directory the run started in, plus this run's environment. */
async function loadRunConfigFromCwd(): Promise<RunConfig> {
  const cwd = process.cwd();
  const file = CONFIG_FILES.map((name) => path.join(cwd, name)).find((candidate) => fs.existsSync(candidate));
  if (!file)
    throw new Error(
      `no ${CONFIG_FILES[0]} in ${cwd}: the fixtures read the config from the directory \`${CLI_NAME} run\` starts in`,
    );
  const { config, dir } = await importKitConfig(file);
  return loadRunConfig(process.env, config, { configDir: dir });
}

/** Core routes plus the app's contract, so an extended control can call its own operations through the broker. */
function routesFor(config: RunConfig): RouteTable {
  const contract = config.kit.testApi?.contract;
  return contract ? mergeRoutes(CORE_ROUTES, loadContractRoutes(contract)) : CORE_ROUTES;
}

const controlClasses = new Map<string, Promise<ControlClass>>();

/** The kit's `Control`, or the app's extension class (`config.control.module`, default export), loaded once. */
function controlClassFor(config: RunConfig): Promise<ControlClass> {
  const ref = config.kit.control?.module;
  if (!ref) return Promise.resolve(Control);
  let loading = controlClasses.get(ref);
  if (!loading) {
    loading = (async () => {
      const spec = ref.startsWith('.') || path.isAbsolute(ref) ? pathToFileURL(path.resolve(ref)).href : ref;
      const loaded = (await import(spec)) as { default?: unknown };
      if (typeof loaded.default !== 'function') throw new Error(`${ref} does not export a Control class as default`);
      return loaded.default as ControlClass;
    })();
    controlClasses.set(ref, loading);
  }
  return loading;
}

interface ControlParts {
  config: RunConfig;
  catalog: Catalog;
  ns: string;
  api: TestApiClient;
}

async function makeControl(parts: ControlParts, onSecret?: (secret: SecretValue) => void): Promise<StateControl> {
  const { config, catalog, ns, api } = parts;
  const Cls = await controlClassFor(config);
  const mail = await loadMailSink(config.kit.mail ?? { sink: 'test-api' }, {
    testApi: { api, handleFor: (address) => handleForAddress(address, ns, catalog) },
  });
  return new Cls({ api, catalog, ns, runId: config.runId, webOrigin: config.endpoints.web, mail, onSecret });
}

/** Browser context options from the project's `use` block (viewport, theme, device) and the persona's locale. */
function contextOptionsFor(testInfo: TestInfo, config: RunConfig, persona: Persona): BrowserContextOptions {
  const use = testInfo.project.use;
  return {
    baseURL: config.endpoints.web,
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    colorScheme: use.colorScheme,
    userAgent: use.userAgent,
    locale: use.locale ?? persona.locale,
    timezoneId: use.timezoneId ?? persona.timezone,
    serviceWorkers: 'block',
  };
}

// The `guard` fixture is typed as its knobs; the store behind it is what the per-context guards read.
const knobStores = new WeakMap<GuardKnobs, GuardKnobStore>();

/** The kit's `test`: Playwright's fixtures and options plus the kit's (`KitTestFixtures`, `KitWorkerFixtures`). */
export type KitTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & KitTestFixtures & KitSelfTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & KitWorkerFixtures
>;

export const test: KitTest = base.extend<KitTestFixtures & KitSelfTestOptions, KitWorkerFixtures>({
  kit: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern
    async ({}, use, workerInfo) => {
      assertNoProxyOverride(workerInfo.project.use, `project "${workerInfo.project.name}"`);
      const config = await loadRunConfigFromCwd();
      const catalog = loadCatalog(config.kit.personas.catalog, { addressPattern: config.kit.personas.addressPattern });
      const ns = namespaceFor(config.slot, workerInfo.parallelIndex);
      // The broker global setup started: workers never hold the runner key (it is not in their environment).
      const brokerUrl = process.env[ENV.BROKER_URL];
      const brokerToken = process.env[ENV.BROKER_TOKEN];
      if (!brokerUrl || !brokerToken) {
        throw new Error(
          `no test-API broker (${ENV.BROKER_URL} and ${ENV.BROKER_TOKEN} are unset): a run starts with \`${CLI_NAME} run\`, whose global setup reads the key and starts the broker`,
        );
      }
      const api = new TestApiHttpClient({
        apiOrigin: config.endpoints.testApi,
        basePath: config.kit.testApi?.basePath,
        keyHeader: config.kit.testApi?.keyHeader,
        headers: config.kit.testApi?.headers,
        routes: routesFor(config),
        transport: { kind: 'broker', url: brokerUrl, token: new Secret(brokerToken, 'broker token') },
      });
      const control = await makeControl({ config, catalog, ns, api });
      const health = await control.health();
      // Seed and reset at the start of the worker's suite: every persona exists and starts from its baseline, so
      // nothing a crashed earlier run left behind can leak into this one.
      const all = Object.keys(catalog.personas);
      const ensured = await control.ensure(all);
      await control.reset(all);
      const userIds = new Map(ensured.map((p) => [personaIdOf(p.handle, ns), p.userId]));
      await use({ config, catalog, ns, api, health, userIds });
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  egressLookup: [undefined, { option: true }],

  sensitive: async ({ kit }, use) => {
    await use(
      new SensitiveText({
        reportDir: kit.config.reportDir,
        codeShape: kit.config.kit.evidence?.codeShape,
        evidenceKey: process.env[ENV.EVIDENCE_KEY] ?? kit.config.runId,
      }),
    );
  },

  control: async ({ kit, sensitive }, use, testInfo) => {
    const control = await makeControl(kit, (secret) => sensitive.add(secret));
    const before = kit.api.log.length;
    let problems: string[] = [];
    try {
      await use(control);
    } finally {
      // Always: what a test created is removed and what it touched is reset, whatever happened in the body.
      problems = await control.teardown();
      const calls = kit.api.log.slice(before).map((c) => `${c.at} ${c.method} ${c.path} -> ${c.status} (${c.ms} ms)`);
      if (calls.length) await testInfo.attach('test-api-calls', { body: calls.join('\n'), contentType: 'text/plain' });
    }
    if (problems.length) throw new Error(redact(`teardown could not clean up:\n  - ${problems.join('\n  - ')}`));
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern
  guard: async ({}, use) => {
    const store = new GuardKnobStore();
    const knobs: GuardKnobs = {
      expectStatus: (url, status) => store.expectStatus(url, status),
      expectSignal: (url, code) => store.expectSignal(url, code),
      allowConsole: (pattern, reason) => store.allowConsole(pattern, reason),
    };
    knobStores.set(knobs, store);
    await use(knobs);
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern
  shot: async ({}, use) => {
    await use((session, step, options) => session.shot(step, options));
  },

  personas: async ({ kit, browser, sensitive, control, guard, egressLookup, proxy, launchOptions }, use, testInfo) => {
    const { config } = kit;
    const { web, api, testApi } = config.endpoints;
    const signals = defaultSignals(config.kit.signals, { apiOrigin: api });
    const policy = egressPolicyFor(config);
    const canaryHost = policy.canaryHost ?? DEFAULTS.canaryHost;
    const fromEnv = process.env[ENV.GUARD_OUTSIDE];
    const outside: OutsideMode =
      fromEnv === 'note' || fromEnv === 'fail' ? fromEnv : (config.kit.hosts?.outside ?? DEFAULTS.outside);
    const evidence = {
      bootCover: config.kit.evidence?.bootCover ?? signals.bootCover,
      maskSelectors: config.kit.evidence?.maskSelectors,
    };
    const hosts = [...new Set([web, api, testApi].map((origin) => new URL(origin).hostname))];
    const theme = testInfo.project.metadata?.theme;
    const sessionProvider = await loadSessionProvider(config.kit.session ?? { provider: 'test-api' }, {
      sessionCookies: signals.sessionCookies,
    });
    const sessions: PersonaSession[] = [];
    const proxies: KitEgressProxy[] = [];

    const browserFor = async (persona: Persona, grant: SessionGrant | null): Promise<PersonaSession> => {
      // T5: the project was checked when the worker started; `test.use()` is only visible here.
      assertNoProxyOverride({ proxy, launchOptions }, 'test.use()');
      if (egressLookup && config.endpoints.kind !== 'local') {
        throw new Error(
          "egressLookup is for local targets only (the kit's self-tests): a remote run resolves through DNS",
        );
      }
      // Its own egress proxy: production and unlisted hosts are refused below Playwright's routing (egress.ts).
      const contextId = `ctx-${randomBytes(6).toString('hex')}`;
      const egress = await startEgressProxy(policy, { contextId, lookup: egressLookup?.lookup });
      proxies.push(egress);
      const context = await browser.newContext({
        ...contextOptionsFor(testInfo, config, persona),
        proxy: { server: egress.url },
        ...(grant?.storageState ? { storageState: grant.storageState } : {}),
      });
      // T1 positive control: this context's traffic reaches this proxy, or the test fails before it opens anything.
      await context.request
        .get(`http://${canaryHost}/?ctx=${contextId}`, { timeout: 10_000, failOnStatusCode: false, maxRedirects: 0 })
        .catch(() => undefined);
      if (!egress.canarySeen) {
        await context.close().catch(() => undefined);
        throw new Error(
          `egress proxy bypassed: the canary request of ${persona.handle}'s context did not reach its own proxy at ${egress.url} (the browser or the platform is not honouring the per-context proxy)`,
        );
      }
      const cookies = grant?.cookies ?? [];
      const scoped = narrowCookies(cookies, hosts);
      if (
        cookies.length &&
        signals.sessionCookies.length &&
        !scoped.some((c) => signals.sessionCookies.includes(c.name))
      ) {
        throw new Error(
          `the session cookie for ${persona.handle} (${signals.sessionCookies.join(', ')}) matches none of the run's hosts (${hosts.join(', ')})`,
        );
      }
      if (scoped.length) await context.addCookies(scoped);
      if (theme) {
        // The project's theme, under the key most apps read; the project's colorScheme covers the rest.
        await context.addInitScript((value: string) => {
          try {
            window.localStorage.setItem('theme', value);
          } catch {
            // storage unavailable: the page follows prefers-color-scheme
          }
        }, theme);
      }
      const attached = await attachGuard(context, {
        policy,
        appOrigins: [web, api, testApi],
        apiOrigin: api,
        signals,
        label: persona.handle,
        outside,
        egress,
        shared: knobStores.get(guard),
      });
      const page = await context.newPage();
      const session = new PersonaSession({
        persona,
        context,
        page,
        guard: attached,
        testInfo,
        sensitive,
        apiOrigin: api,
        signals,
        evidence,
      });
      sessions.push(session);
      return session;
    };

    const personas: Personas = {
      sessions,
      persona: (id) => control.persona(id),
      address: (name) => control.address(name),
      open: async <const T extends readonly string[]>(...ids: T) => {
        if (!ids.length) throw new Error('personas.open() needs at least one persona id');
        const twice = ids.find((id, i) => ids.indexOf(id) !== i || sessions.some((s) => s.id === id));
        if (twice)
          throw new Error(
            `persona ${twice} is already open in this test: a second session would end the first (a login rotates the session)`,
          );
        const opened: PersonaSession[] = [];
        for (const id of ids) {
          const persona = control.persona(id);
          if (persona.auth === 'password') {
            throw new Error(
              `${id} is a sign-in persona (auth: password): it signs in through the UI only, never through the session endpoint`,
            );
          }
          const grant = await sessionProvider.mint(persona, { api: kit.api, runId: config.runId });
          control.touched.add(id);
          opened.push(await browserFor(persona, grant));
        }
        return opened as unknown as { [K in keyof T]: PersonaSession };
      },
      openSignedOut: async (id) => {
        const persona = control.persona(id);
        if (sessions.some((s) => s.id === id)) throw new Error(`persona ${id} is already open in this test`);
        control.touched.add(id);
        return browserFor(persona, null);
      },
    };

    await use(personas);

    // Judged on what the body did, not on test.fail(): a body that finished must have left its evidence.
    const passed = testInfo.status === 'passed';
    const skipped = testInfo.status === 'skipped';
    const gate = process.env[ENV.A11Y] === 'gate';
    const violations: string[] = [];
    for (const session of sessions) {
      if (!passed && !skipped && session.openedScreen) {
        // For the triage only: marked FAILED, never mistaken for evidence. Masked like every screenshot; if the
        // masking cannot run (a closed or broken page), there is no triage screenshot rather than an unmasked one.
        await takeShot(
          session.page,
          shotPath(testInfo, session.id, 'FAILED'),
          sensitive,
          { triage: true },
          evidence,
        ).catch(() => undefined);
      } else if (passed && session.openedScreen && session.shots.length === 0) {
        violations.push(
          `[${session.persona.handle}] opened a screen but saved no screenshot of it (call shot() after the checks)`,
        );
      }
      await session.guard.settle().catch(() => undefined);
      violations.push(...session.guard.violations);
      const lists: Array<[GuardListName, readonly string[]]> = [
        ['outside', session.guard.outside],
        ['third-party', session.guard.thirdParty],
        ['dev-hosts', session.guard.devHosts],
        ['analytics-blocked', session.guard.analyticsBlocked],
        ['api-errors', session.guard.apiErrors],
        ['cancelled', session.guard.cancelled],
      ];
      for (const [name, list] of lists) {
        if (list.length)
          await testInfo.attach(`${session.id}-${name}`, {
            body: [...new Set(list)].join('\n'),
            contentType: 'text/plain',
          });
      }
      if (session.a11yFindings.length) {
        await testInfo.attach(`${session.id}-a11y`, {
          body: JSON.stringify(session.a11yFindings, null, 2),
          contentType: 'application/json',
        });
        if (gate) {
          for (const { step, findings } of session.a11yFindings) {
            for (const f of findings.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
              violations.push(
                `[${session.persona.handle}] accessibility (${step}): ${f.id} ${f.impact} on ${f.nodes} element(s): ${f.help}`,
              );
            }
          }
        }
      }
      await session.context.close().catch(() => undefined);
    }
    await Promise.all(proxies.map((p) => p.close()));
    if (!skipped) {
      expect(
        violations,
        'console errors, failed requests, other hosts, unexpected sign-outs and missing evidence',
      ).toEqual([]);
    }
  },
});

export { expect };
