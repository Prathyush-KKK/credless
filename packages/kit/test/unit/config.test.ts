// The prod lock and the run config (private U03–U05): production detection from the config's rules, the overlap
// check, target URLs, run ids, slots and namespaces.
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertNoProductionOverlap,
  assertTargetUrl,
  defaultStagingDir,
  isNonProdHost,
  isProdHost,
  isProductionHost,
  loadRunConfig,
  namespaceFor,
  newRunId,
  pinRunId,
  ruleCouldMatchProduction,
} from '../../src/config/load.ts';
import { defineConfig } from '../../src/config/schema.ts';
import { DEFAULTS, ENV, type KitConfig, type ProductionConfig } from '../../src/types.ts';

const production: ProductionConfig = {
  domains: ['example.com', 'example.app'],
  nonProductionPattern: '^(dev|staging)[a-z0-9-]*\\.example\\.com$',
};

const base: KitConfig = {
  targets: {
    dev: { web: 'https://dev.example.com', api: 'https://dev-api.example.com' },
    local: { web: 'http://localhost:8081', api: 'http://127.0.0.1:8080', kind: 'local' },
  },
  production,
  hosts: { thirdParty: ['*.googleapis.com', 'fonts.gstatic.com'], analytics: ['*.googletagmanager.com'] },
  personas: { catalog: 'e2e/personas.yaml', addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$' },
  key: { source: 'env' },
};

describe('production detection', () => {
  test('a production word as a label or label part is production anywhere, whatever the target says', () => {
    for (const host of [
      'prod-api.example.com',
      'api.prod.example.com',
      'production.example.com',
      'app.prod.example',
      'prod.other.org',
      'DEV-API.PROD.example.com.',
    ]) {
      expect(isProdHost(host, production, ['prod-api.example.com']), host).toBe(true);
    }
    expect(isProdHost('myprod.example.org', production)).toBe(false);
    expect(isProdHost('product-notes.example.org', production)).toBe(false);
  });

  test('a host on or under a production domain is production unless it is a target host or matches the pattern', () => {
    for (const host of ['example.com', 'www.example.com', 'api.example.com', 'deep.sub.example.app', 'Example.COM.']) {
      expect(isProdHost(host, production), host).toBe(true);
    }
    for (const host of [
      'dev.example.com',
      'dev-api.example.com',
      'staging-web.example.com',
      'other.example.org',
      'localhost',
      '127.0.0.1',
    ]) {
      expect(isProdHost(host, production), host).toBe(false);
    }
    expect(isProdHost('preview.example.com', production, ['preview.example.com'])).toBe(false);
    expect(isProductionHost('preview.example.com', { production }, [])).toBe(true);
    expect(isProdHost('www.example.com', { domains: ['example.com'] })).toBe(true);
  });

  test('isNonProdHost lists the organisation hosts the pattern allows, never one with a production word', () => {
    expect(isNonProdHost('dev-other.example.com', production)).toBe(true);
    expect(isNonProdHost('www.example.com', production)).toBe(false);
    expect(isNonProdHost('dev-prod.example.com', production)).toBe(false);
    expect(isNonProdHost('dev.example.com', { domains: ['example.com'] })).toBe(false);
  });

  test('host rules that could reach production are refused at load', () => {
    expect(ruleCouldMatchProduction('*.googleapis.com', production)).toBe(false);
    expect(ruleCouldMatchProduction('fonts.gstatic.com', production)).toBe(false);
    expect(ruleCouldMatchProduction('*.example.com', production)).toBe(true);
    expect(ruleCouldMatchProduction('*.com', production)).toBe(true);
    expect(ruleCouldMatchProduction('api.example.com', production)).toBe(true);
    expect(ruleCouldMatchProduction('dev-cdn.example.com', production)).toBe(false);
    expect(ruleCouldMatchProduction('*.prod.other.org', production)).toBe(true);
    expect(() => assertNoProductionOverlap(base)).not.toThrow();
    expect(() => assertNoProductionOverlap({ ...base, hosts: { thirdParty: ['*.example.com'] } })).toThrow(
      /thirdParty rule "\*\.example\.com" could match a production host/,
    );
    expect(() => assertNoProductionOverlap({ ...base, hosts: { analytics: ['api.example.com'] } })).toThrow(
      /analytics rule/,
    );
  });

  test('a target named like production or pointing at a production host is refused', () => {
    expect(() => assertNoProductionOverlap({ ...base, targets: { prod: base.targets.dev as never } })).toThrow(
      /target "prod" is named like production/,
    );
    expect(() =>
      assertNoProductionOverlap({ ...base, targets: { 'pre-production': base.targets.dev as never } }),
    ).toThrow(/named like production/);
    expect(() =>
      assertNoProductionOverlap({
        ...base,
        targets: { x: { web: 'https://dev.example.com', api: 'https://prod-api.example.com' } },
      }),
    ).toThrow(/points at prod-api\.example\.com, a production host/);
  });
});

describe('target URLs', () => {
  test('production hosts are refused for every target; a target accepts only its own hosts; remote needs https', () => {
    for (const host of [
      'example.com',
      'www.example.com',
      'api.example.com',
      'prod-api.example.com',
      'dev-prod.example.com',
    ]) {
      expect(() => assertTargetUrl(`https://${host}`, 'dev', base), host).toThrow(/production/);
    }
    expect(assertTargetUrl('https://dev.example.com/', 'dev', base).hostname).toBe('dev.example.com');
    expect(() => assertTargetUrl('http://dev.example.com', 'dev', base)).toThrow(/https/);
    expect(() => assertTargetUrl('https://staging-web.example.com', 'dev', base)).toThrow(/not a dev host/);
    expect(() => assertTargetUrl('https://evil.example.org', 'local', base)).toThrow(/not a local host/);
    expect(assertTargetUrl('http://localhost:8081', 'local', base).hostname).toBe('localhost');
    expect(() => assertTargetUrl('file:///etc/passwd', 'local', base)).toThrow(/http/);
    expect(() => assertTargetUrl('https://user:pw@dev.example.com', 'dev', base)).toThrow(/credentials/);
    expect(() => assertTargetUrl('not a url', 'dev', base)).toThrow(/not a URL/);
    expect(() => assertTargetUrl('https://dev.example.com', 'nope', base)).toThrow(/must be one of dev, local/);
  });
});

describe('loadRunConfig', () => {
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    [ENV.TARGET]: 'dev',
    [ENV.STAGING_DIR]: '/tmp/kit-staging',
    ...extra,
  });

  test('resolves the target, applies overrides that pass the same checks, and pins the shapes', () => {
    const config = loadRunConfig(env({ [ENV.SLOT]: 'b' }), base, { configDir: '/work/app' });
    expect(config.target).toBe('dev');
    expect(config.endpoints).toEqual({
      web: 'https://dev.example.com',
      api: 'https://dev-api.example.com',
      testApi: 'https://dev-api.example.com',
      kind: 'remote',
    });
    expect(config.slot).toBe('b');
    expect(config.runId).toMatch(/^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$/);
    expect(config.stagingDir).toBe(path.resolve('/tmp/kit-staging'));
    expect(config.reportDir).toBe(path.resolve('/tmp/kit-staging', config.runId));
    expect(config.targetHosts).toEqual(['dev.example.com', 'dev-api.example.com']);
    expect(config.hasKeySource).toBe(true);
    expect(config.kit.personas.catalog).toBe(path.resolve('/work/app/e2e/personas.yaml'));
    expect(config.kit.personas.addressPattern).toBe(base.personas.addressPattern);
    const pinned = loadRunConfig(
      env({ [ENV.RUN_ID]: '20261008T101500Z-ab12', [ENV.REPORT_DIR]: '/tmp/elsewhere' }),
      base,
    );
    expect(pinned.runId).toBe('20261008T101500Z-ab12');
    expect(pinned.reportDir).toBe(path.resolve('/tmp/elsewhere'));
  });

  test('refuses an unknown or missing target, a production override, a bad run id and a bad slot', () => {
    expect(() => loadRunConfig(env({ [ENV.TARGET]: 'prod' }), base)).toThrow(
      new RegExp(`${ENV.TARGET} must be one of dev, local`),
    );
    expect(() => loadRunConfig({}, base)).toThrow(new RegExp(`${ENV.TARGET} is not set`));
    expect(() => loadRunConfig(env({ [ENV.API_URL]: 'https://prod-api.example.com' }), base)).toThrow(/production/);
    expect(() => loadRunConfig(env({ [ENV.API_URL]: 'https://api.example.com' }), base)).toThrow(/production/);
    expect(() => loadRunConfig(env({ [ENV.WEB_URL]: 'https://dev-other.example.com' }), base)).toThrow(
      /not a dev host/,
    );
    expect(() => loadRunConfig(env({ [ENV.RUN_ID]: 'yesterday' }), base)).toThrow(
      new RegExp(`${ENV.RUN_ID} must look like`),
    );
    expect(() => loadRunConfig(env({ [ENV.SLOT]: 'ab' }), base)).toThrow(new RegExp(ENV.SLOT));
    expect(() =>
      loadRunConfig(env(), {
        ...base,
        targets: { dev: { web: 'https://dev.example.com', api: 'https://prod-api.example.com' } },
      }),
    ).toThrow(/production/);
  });

  test('a local target may be http on loopback; the separate test-API origin is kept', () => {
    const local = loadRunConfig(env({ [ENV.TARGET]: 'local' }), base);
    expect(local.endpoints.kind).toBe('local');
    expect(local.endpoints.testApi).toBe('http://127.0.0.1:8080');
    const split: KitConfig = {
      ...base,
      targets: {
        dev: {
          web: 'https://dev.example.com',
          api: 'https://dev-api.example.com',
          testApi: 'https://dev-test.example.com',
        },
      },
    };
    expect(loadRunConfig(env(), split).endpoints.testApi).toBe('https://dev-test.example.com');
    expect(loadRunConfig(env(), split).targetHosts).toContain('dev-test.example.com');
  });

  test('run ids, pinning, namespaces and the default staging dir', () => {
    expect(newRunId(new Date('2026-10-08T10:15:00Z'))).toMatch(/^20261008T101500Z-[a-z0-9]{4}$/);
    const e: NodeJS.ProcessEnv = {};
    const first = pinRunId(e);
    expect(pinRunId(e)).toBe(first);
    expect(e[ENV.RUN_ID]).toBe(first);
    expect(namespaceFor('a', 3)).toBe('a3');
    expect(namespaceFor('z', 99)).toBe('z99');
    expect(() => namespaceFor('a', 100)).toThrow(/out of range/);
    expect(() => namespaceFor('ab', 1)).toThrow(/slot/);
    expect(defaultStagingDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/me')).toBe(
      path.join('/xdg', DEFAULTS.cacheDirName, 'staging'),
    );
    expect(defaultStagingDir({}, 'linux', '/home/me')).toBe(
      path.join('/home/me', '.cache', DEFAULTS.cacheDirName, 'staging'),
    );
    expect(defaultStagingDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me')).toBe(
      path.join('C:\\Users\\me\\AppData\\Local', DEFAULTS.cacheDirName, 'staging'),
    );
  });
});

describe('defineConfig', () => {
  test('fills the defaults and keeps what was given', () => {
    const config = defineConfig(base);
    expect(config.production.words).toEqual([...DEFAULTS.productionWords]);
    expect(config.targets.dev).toEqual({
      web: 'https://dev.example.com',
      api: 'https://dev-api.example.com',
      testApi: 'https://dev-api.example.com',
      kind: 'remote',
    });
    expect(config.targets.local?.kind).toBe('local');
    expect(config.personas.slot).toBe(DEFAULTS.slot);
    expect(config.personas.workers).toBe(DEFAULTS.workers);
    expect(config.testApi).toEqual({ basePath: DEFAULTS.basePath, keyHeader: DEFAULTS.keyHeader, headers: {} });
    expect(config.key).toEqual({ source: 'env', name: ENV.RUNNER_KEY });
    expect(config.session).toEqual({ provider: 'test-api' });
    expect(config.mail).toEqual({ sink: 'test-api' });
    expect(config.hosts?.outside).toBe(DEFAULTS.outside);
    expect(config.hosts?.thirdParty).toEqual(['*.googleapis.com', 'fonts.gstatic.com']);
    expect(config.evidence).toEqual({
      reportsDir: DEFAULTS.reportsDir,
      codeShape: DEFAULTS.codeShape,
      trace: DEFAULTS.trace,
      retainOnPass: false,
    });
    const signOut = () => true;
    const withSignals = defineConfig({ ...base, signals: { unexpectedSignOut: signOut, sessionCookies: ['s'] } });
    expect(withSignals.signals?.unexpectedSignOut).toBe(signOut);
  });

  test('lists every problem with its path, and refuses an overlap with production', () => {
    const bad = {
      ...base,
      targets: { Dev: base.targets.dev },
      production: { ...production, nonProductionPattern: '(' },
      extra: true,
    } as unknown as KitConfig;
    const message = (() => {
      try {
        defineConfig(bad);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/the config is invalid/);
    expect(message).toMatch(/targets\.Dev/);
    expect(message).toMatch(/production\.nonProductionPattern: must be a valid regular expression/);
    expect(message).toMatch(/Unrecognized key: "extra"/);
    expect(() => defineConfig({ ...base, key: { source: 'exec', preset: 'op' } })).toThrow(
      /either argv, or a preset with its ref/,
    );
    expect(() => defineConfig({ ...base, testApi: { basePath: '_test/' } })).toThrow(/basePath/);
    expect(() => defineConfig({ ...base, hosts: { thirdParty: ['*.example.com'] } })).toThrow(
      /could match a production host/,
    );
    expect(() => defineConfig({ ...base, targets: { production: base.targets.dev as never } })).toThrow(
      /named like production/,
    );
  });
});
