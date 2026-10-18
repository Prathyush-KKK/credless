// Where a run points, and the locks that keep it off production.
//
// A run targets one named environment of the config. The hosts come from the config, never from a constant; the
// overrides `ENV.WEB_URL` / `ENV.API_URL` may replace them only with hosts that pass the same checks. Production
// detection (plan §4.1): a host with a production word as a label or label part is production anywhere; a host on
// or under one of the organisation's domains is production unless it is a target host or matches the non-production
// pattern. The loader refuses a config where production and the targets overlap.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { namespaceFor } from '../core/catalog.ts';
import {
  DEFAULTS,
  ENV,
  type HostGlob,
  type KitConfig,
  PATTERNS,
  type ProductionConfig,
  type RunConfig,
  type Target,
} from '../types.ts';

export { namespaceFor };

const normalizeHost = (hostname: string) => hostname.toLowerCase().replace(/\.+$/, '');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function productionWords(production: ProductionConfig): RegExp[] {
  return (production.words ?? DEFAULTS.productionWords).map(
    (w) => new RegExp(`(^|[.-])${escapeRegExp(w.toLowerCase())}([.-]|$)`),
  );
}

function nonProductionPattern(production: ProductionConfig): RegExp | null {
  return production.nonProductionPattern ? new RegExp(production.nonProductionPattern) : null;
}

function underDomain(host: string, domain: string): boolean {
  const d = normalizeHost(domain);
  return host === d || host.endsWith(`.${d}`);
}

/** Does the host carry a production word (`prod`, `production`) as a label or a label part? Never relaxed. */
export function hasProductionWord(hostname: string, production: ProductionConfig): boolean {
  const host = normalizeHost(hostname);
  return productionWords(production).some((p) => p.test(host));
}

/**
 * Production, or anything that could be: a production word anywhere, or the organisation's domains except the
 * target's own hosts and hosts matching `nonProductionPattern`. Checked on every URL a run is given and on every
 * request a persona's browser makes.
 */
export function isProdHost(
  hostname: string,
  production: ProductionConfig,
  targetHosts: readonly string[] = [],
): boolean {
  const host = normalizeHost(hostname);
  if (hasProductionWord(host, production)) return true;
  if (targetHosts.some((t) => normalizeHost(t) === host)) return false;
  if (nonProductionPattern(production)?.test(host)) return false;
  return production.domains.some((d) => underDomain(host, d));
}

/** The stub's name for {@link isProdHost}. */
export function isProductionHost(
  hostname: string,
  config: Pick<KitConfig, 'production'>,
  targetHosts: readonly string[] = [],
): boolean {
  return isProdHost(hostname, config.production, targetHosts);
}

/** A non-production host of the organisation that is not the run's own (`nonProductionPattern`): the guard's `dev` list. */
export function isNonProdHost(hostname: string, production: ProductionConfig): boolean {
  const host = normalizeHost(hostname);
  if (hasProductionWord(host, production)) return false;
  return nonProductionPattern(production)?.test(host) ?? false;
}

/** Does a host rule (exact host or `*.label.tld` glob) match a hostname? */
export function hostMatchesRule(hostname: string, rule: HostGlob): boolean {
  const host = normalizeHost(hostname);
  const r = normalizeHost(rule);
  if (r.startsWith('*.')) {
    const suffix = r.slice(2);
    return host.endsWith(`.${suffix}`);
  }
  return host === r;
}

/**
 * Could a host rule match a production host? A glob under (or over) an organisation domain, an exact host that is
 * production under the rules, or any rule carrying a production word. Such a rule is refused at load.
 */
export function ruleCouldMatchProduction(
  rule: HostGlob,
  production: ProductionConfig,
  targetHosts: readonly string[] = [],
): boolean {
  const r = normalizeHost(rule);
  if (hasProductionWord(r.replace(/^\*\./, ''), production)) return true;
  if (r.startsWith('*.')) {
    const suffix = r.slice(2);
    return production.domains.some((d) => underDomain(suffix, d) || underDomain(normalizeHost(d), suffix));
  }
  return isProdHost(r, production, targetHosts);
}

/** The hostnames of a target's origins (web, api, testApi), deduplicated. */
export function targetHostsOf(target: Target): string[] {
  const hosts = new Set<string>();
  for (const origin of [target.web, target.api, target.testApi ?? target.api])
    hosts.add(normalizeHost(new URL(origin).hostname));
  return [...hosts];
}

/**
 * Production rules and the targets never overlap: no target host carries a production word, no target name does,
 * no third-party or analytics rule could reach production, and the non-production pattern never matches a host
 * with a production word in it (it would be unreachable anyway, but it is a sign of a wrong pattern).
 */
export function assertNoProductionOverlap(config: Pick<KitConfig, 'targets' | 'production' | 'hosts'>): void {
  const { production } = config;
  for (const [name, target] of Object.entries(config.targets)) {
    if (hasProductionWord(name, production) || hasProductionWord(name.replace(/[^a-z0-9]+/g, '-'), production)) {
      throw new Error(`refused: target "${name}" is named like production; the kit never runs against production`);
    }
    for (const host of targetHostsOf(target)) {
      if (hasProductionWord(host, production))
        throw new Error(`refused: target "${name}" points at ${host}, a production host`);
    }
  }
  const allTargetHosts = Object.values(config.targets).flatMap((t) => targetHostsOf(t));
  for (const [list, rules] of [
    ['hosts.thirdParty', config.hosts?.thirdParty ?? []],
    ['hosts.analytics', config.hosts?.analytics ?? []],
  ] as const) {
    for (const rule of rules) {
      if (ruleCouldMatchProduction(rule, production, allTargetHosts)) {
        throw new Error(`refused: ${list} rule "${rule}" could match a production host`);
      }
    }
  }
}

export interface TargetUrlConfig {
  production: ProductionConfig;
  targets: Record<string, Target>;
}

/** Throws unless the URL is http(s) without credentials, not production, one of the target's own hosts, and https for a remote target. */
export function assertTargetUrl(url: string, targetName: string, config: TargetUrlConfig): URL {
  const target = config.targets[targetName];
  if (!target)
    throw new Error(`${ENV.TARGET} must be one of ${Object.keys(config.targets).join(', ')} (got "${targetName}")`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`refused: ${url} is not http(s)`);
  if (parsed.username || parsed.password) throw new Error(`refused: ${url} carries credentials`);
  const hosts = targetHostsOf(target);
  if (isProdHost(parsed.hostname, config.production, hosts)) {
    throw new Error(`refused: ${parsed.hostname} is production. The kit never runs against production.`);
  }
  const host = normalizeHost(parsed.hostname);
  if (!hosts.includes(host))
    throw new Error(`refused: ${host} is not a ${targetName} host (allowed: ${hosts.join(', ')})`);
  if ((target.kind ?? 'remote') === 'remote' && parsed.protocol !== 'https:') {
    throw new Error(`refused: ${targetName} is a remote target and must be https (${url})`);
  }
  return parsed;
}

/** A new run id (`PATTERNS.runId`): UTC stamp plus four random base-36 characters. */
export function newRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Pin the run id for every worker of this run (Playwright starts workers after the config is evaluated). */
export function pinRunId(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[ENV.RUN_ID];
  if (existing) return existing;
  const runId = newRunId();
  env[ENV.RUN_ID] = runId;
  return runId;
}

/**
 * The private staging dir when neither `ENV.STAGING_DIR` nor `evidence.stagingDir` names one: the per-user cache
 * dir (docs/conventions.md, "Secrets"): `$XDG_CACHE_HOME/<kit>/staging` or `~/.cache/<kit>/staging` on POSIX,
 * `%LOCALAPPDATA%\<kit>\staging` on Windows.
 */
export function defaultStagingDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, DEFAULTS.cacheDirName, 'staging');
  }
  const cache = env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, DEFAULTS.cacheDirName, 'staging');
}

export interface LoadRunConfigOptions {
  /** the directory of the config file; `personas.catalog` and `testApi.contract` are resolved against it (default: cwd) */
  configDir?: string;
  /** injected in tests */
  platform?: NodeJS.Platform;
}

/**
 * This run's configuration from the environment and the validated config. Throws (and the run stops) on anything
 * unsafe: an unknown target, a target named or pointing at production, an override that is not one of the
 * target's hosts, a bad run id or slot.
 */
export function loadRunConfig(
  env: NodeJS.ProcessEnv,
  kitConfig: KitConfig,
  options: LoadRunConfigOptions = {},
): RunConfig {
  const configDir = path.resolve(options.configDir ?? process.cwd());
  assertNoProductionOverlap(kitConfig);

  const targetName = (env[ENV.TARGET] ?? '').trim();
  if (!targetName) throw new Error(`${ENV.TARGET} is not set (one of ${Object.keys(kitConfig.targets).join(', ')})`);
  const target = kitConfig.targets[targetName];
  if (!target)
    throw new Error(`${ENV.TARGET} must be one of ${Object.keys(kitConfig.targets).join(', ')} (got "${targetName}")`);

  const strip = (origin: string) => origin.replace(/\/+$/, '');
  const web = strip(env[ENV.WEB_URL] ?? target.web);
  const api = strip(env[ENV.API_URL] ?? target.api);
  // an api override moves the test API too, unless the config names a separate test-API origin
  const testApi = strip(target.testApi && target.testApi !== target.api ? target.testApi : api);
  const endpoints: RunConfig['endpoints'] = { web, api, testApi, kind: target.kind ?? 'remote' };
  for (const origin of [web, api, testApi]) assertTargetUrl(origin, targetName, kitConfig);

  const runId = env[ENV.RUN_ID] ?? newRunId();
  if (!PATTERNS.runId.test(runId))
    throw new Error(`${ENV.RUN_ID} must look like 20261008T101500Z-ab12 (got "${runId}")`);
  const slot = (env[ENV.SLOT] ?? kitConfig.personas.slot ?? DEFAULTS.slot).trim();
  if (!PATTERNS.slot.test(slot)) throw new Error(`${ENV.SLOT} must be one lowercase letter (got "${slot}")`);

  const stagingDir = path.resolve(
    env[ENV.STAGING_DIR] || kitConfig.evidence?.stagingDir || defaultStagingDir(env, options.platform),
  );
  const reportDir = path.resolve(env[ENV.REPORT_DIR] || path.join(stagingDir, runId));

  // A relative module reference is relative to the config file, like the catalog and the contract, never to
  // whichever directory the process started in (the fixtures and the CLI may run from different places).
  const resolveModule = (ref: string): string => (ref.startsWith('.') ? path.resolve(configDir, ref) : ref);
  const kit: KitConfig = {
    ...kitConfig,
    personas: { ...kitConfig.personas, catalog: path.resolve(configDir, kitConfig.personas.catalog) },
    testApi: kitConfig.testApi?.contract
      ? { ...kitConfig.testApi, contract: path.resolve(configDir, kitConfig.testApi.contract) }
      : kitConfig.testApi,
    control: kitConfig.control ? { module: resolveModule(kitConfig.control.module) } : kitConfig.control,
    session:
      kitConfig.session?.provider === 'module'
        ? { ...kitConfig.session, module: resolveModule(kitConfig.session.module) }
        : kitConfig.session,
    mail:
      kitConfig.mail?.sink === 'module'
        ? { ...kitConfig.mail, module: resolveModule(kitConfig.mail.module) }
        : kitConfig.mail,
  };
  return {
    target: targetName,
    endpoints,
    runId,
    slot,
    reportDir,
    stagingDir,
    kit,
    targetHosts: [...new Set([web, api, testApi].map((o) => new URL(o).hostname.toLowerCase()))],
    hasKeySource: Boolean(kitConfig.key),
  };
}

/** Import a `<kit>.config.ts` (or `.js`/`.mjs`) and return its validated default export with its directory. */
export async function importKitConfig(configPath: string): Promise<{ config: KitConfig; dir: string }> {
  const file = path.resolve(configPath);
  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const candidate = loaded.default;
  if (!candidate || typeof candidate !== 'object')
    throw new Error(`${file} has no default export (export default defineConfig({...}))`);
  // defineConfig is imported lazily: schema.ts imports this file for the overlap check
  const { defineConfig } = await import('./schema.ts');
  return { config: defineConfig(candidate as KitConfig), dir: path.dirname(file) };
}
