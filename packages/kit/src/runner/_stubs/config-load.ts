// Stand-in for src/config/load.ts (Task 1), with the frozen signature of src/config/index.ts: finds and imports
// `<kit>.config.*`, picks the target from the environment, refuses production and private hosts on remote targets,
// and pins the run id. No zod validation here; the real loader validates the whole config.
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, ENV, type KitConfig, PATTERNS, type RunConfig, type Target } from '../../types.ts';
import { findProject } from '../project.ts';
import { stagingDirPath } from '../staging.ts';

/** A new run id (`PATTERNS.runId`). */
export function newRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** The namespace of a worker: slot letter plus parallel index, for example `a0`. */
export function namespaceFor(slot: string, parallelIndex: number): string {
  if (parallelIndex < 0 || parallelIndex > 99) throw new Error(`parallel index out of range: ${parallelIndex}`);
  return `${slot}${parallelIndex}`;
}

function hostOf(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

/** Production by word (any label part) or by domain (unless a target host or the non-production pattern). */
export function isProductionHost(
  hostname: string,
  config: Pick<KitConfig, 'production'>,
  targetHosts: string[],
): boolean {
  const host = hostname.toLowerCase();
  const words: readonly string[] = config.production.words ?? DEFAULTS.productionWords;
  for (const label of host.split('.')) {
    for (const part of label.split(/[-_]/)) if (words.includes(part)) return true;
  }
  if (targetHosts.includes(host)) return false;
  const nonProd = config.production.nonProductionPattern ? new RegExp(config.production.nonProductionPattern) : null;
  if (nonProd?.test(host)) return false;
  return config.production.domains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
}

async function importConfig(file: string): Promise<KitConfig> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: KitConfig; config?: KitConfig };
  const config = mod.default ?? mod.config;
  if (!config || typeof config !== 'object' || !config.targets) throw new Error(`${file} does not export a config`);
  return config;
}

/** Load the config file and resolve this run from `env` (the frozen signature). Throws on anything unsafe. */
export async function loadRunConfig(
  options: { configPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunConfig> {
  const env = options.env ?? process.env;
  const project = findProject(process.cwd(), options.configPath);
  const kit = await importConfig(project.configFile);
  const target = env[ENV.TARGET];
  if (!target) throw new Error(`${ENV.TARGET} is not set`);
  const declared: Target | undefined = kit.targets[target];
  if (!declared) throw new Error(`unknown target: ${target} (targets: ${Object.keys(kit.targets).join(', ')})`);
  const strip = (u: string) => u.replace(/\/+$/, '');
  const endpoints: RunConfig['endpoints'] = {
    web: strip(env[ENV.WEB_URL] ?? declared.web),
    api: strip(env[ENV.API_URL] ?? declared.api),
    testApi: strip(declared.testApi ?? env[ENV.API_URL] ?? declared.api),
    kind: declared.kind ?? 'remote',
  };
  const declaredHosts = [declared.web, declared.api, declared.testApi].filter((u): u is string => !!u).map(hostOf);
  const targetHosts = [endpoints.web, endpoints.api, endpoints.testApi].map(hostOf);
  for (const origin of [endpoints.web, endpoints.api, endpoints.testApi]) {
    const host = hostOf(origin);
    if (isProductionHost(host, kit, declaredHosts)) throw new Error(`refused: ${host} is a production host`);
  }
  const runId = env[ENV.RUN_ID] ?? newRunId();
  if (!PATTERNS.runId.test(runId))
    throw new Error(`${ENV.RUN_ID} must look like 20261008T101500Z-ab12 (got "${runId}")`);
  const slot = (env[ENV.SLOT] ?? kit.personas?.slot ?? DEFAULTS.slot).trim();
  if (!PATTERNS.slot.test(slot)) throw new Error(`${ENV.SLOT} must be one lowercase letter (got "${slot}")`);
  const stagingDir = stagingDirPath({
    env,
    override: env[ENV.STAGING_DIR] ?? kit.evidence?.stagingDir,
    cwd: project.root,
  });
  const reportDir = path.resolve(project.root, env[ENV.REPORT_DIR] ?? path.join(stagingDir, runId));
  return { target, endpoints, runId, slot, reportDir, stagingDir, kit, targetHosts, hasKeySource: Boolean(kit.key) };
}
