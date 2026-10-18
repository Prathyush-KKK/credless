// Playwright's globalSetup for a run, in the main process before any worker starts:
//  1. write run.json (no secrets);
//  2. take the key the CLI handed over as a file (read once, deleted at once), or, for a local target with no
//     handover (the demo, the self-tests), read the config's own stand-in key source;
//  3. check the test API once, so a target without it fails in seconds with one clear message; refuse a remote target
//     whose sinks are not all wired (test mail, pushes or analytics would reach real systems);
//  4. start the loopback broker that holds the key; export only its URL and the per-run token to the workers, and
//     remove the key and the key file's name from the environment;
//  5. turn the workers' shim on (loopback only; v0.1 has no run-level proxy).
// The function it returns is the teardown: cleanupRun (the safety net), run.json finished, the broker closed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { KIT_NAME } from '../brand.ts';
import { CORE_ROUTES, DEFAULTS, ENV, type Health, type RunMeta, type SecretValue } from '../types.ts';
import {
  Control,
  createKeySource,
  loadCatalog,
  loadContractRoutes,
  loadProjectConfig,
  mailSinkFor,
  mergeRoutes,
  runnerKeyFromRunner,
  startBroker,
  TestApiClient,
} from './deps.ts';
import { findProject } from './project.ts';
import { WORKER_PROXY_ENV } from './shim-policy.ts';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The kit's own version, from its package.json above the source tree (`src/runner/`) or the bundle (`dist/`). The
 * name is checked: two levels above `dist/` is the installing project's `node_modules`, whose package.json, if one
 * is ever there, is not ours.
 */
export function kitVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string };
      if (pkg.name === KIT_NAME) return pkg.version ?? '0.0.0';
    } catch {
      // next
    }
  }
  return '0.0.0';
}

function playwrightVersionHere(root: string): string | undefined {
  try {
    return (createRequire(path.join(root, 'package.json'))('@playwright/test/package.json') as { version?: string })
      .version;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const config = await loadProjectConfig({ env: process.env });
  const project = findProject(process.cwd());
  const local = config.endpoints.kind === 'local';
  const catalogFile = path.resolve(project.root, config.kit.personas.catalog);
  const catalog = loadCatalog(catalogFile);
  fs.mkdirSync(config.reportDir, { recursive: true, mode: 0o700 });
  const runFile = path.join(config.reportDir, 'run.json');
  const meta: RunMeta = {
    runId: config.runId,
    target: config.target,
    endpoints: config.endpoints,
    slot: config.slot,
    startedAt: new Date().toISOString(),
    kit: { name: KIT_NAME, version: kitVersion() },
    node: process.version,
    playwright: playwrightVersionHere(project.root),
    git: {
      sha: git(project.root, ['rev-parse', 'HEAD']),
      branch: git(project.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: Boolean(git(project.root, ['status', '--porcelain'])),
    },
    catalog: {
      status: catalog.status,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex'),
    },
  };
  writeJson(runFile, meta);

  // The CLI hands the key over as a file in the private staging dir; read and deleted here, so it is in no
  // environment at all. From here on only the broker holds it.
  let key: SecretValue | null = runnerKeyFromRunner(process.env);
  if (!key && local && config.kit.key) key = await createKeySource(config.kit.key).read();
  if (!key)
    throw new Error(
      `no runner key: start runs with \`${KIT_NAME} run --target ${config.target}\`, which reads it at run time`,
    );
  if (!local && !process.env[ENV.EVIDENCE_KEY]) {
    throw new Error(
      `${ENV.EVIDENCE_KEY} is not set: start runs with \`${KIT_NAME} run\` (it keys the list of codes the scrubber removes)`,
    );
  }
  const basePath = config.kit.testApi?.basePath ?? DEFAULTS.basePath;
  const keyHeader = config.kit.testApi?.keyHeader ?? DEFAULTS.keyHeader;
  const headers = config.kit.testApi?.headers ?? {};
  const direct = new TestApiClient({
    apiOrigin: config.endpoints.testApi,
    transport: { kind: 'direct', key },
    routes: CORE_ROUTES,
    basePath,
    keyHeader,
    headers,
  });
  const ns = `${config.slot}0`;
  const control = new Control({
    api: direct,
    catalog,
    ns,
    runId: config.runId,
    webOrigin: config.endpoints.web,
    mail: await mailSinkFor(direct, config.kit.mail, { ns, catalog }),
  });
  const health: Health = await control.health();
  meta.health = {
    environment: health.environment,
    keyId: health.keyId,
    version: health.version,
    sinks: health.sinks,
    extensions: health.extensions,
  };
  writeJson(runFile, meta);
  const unwired = Object.entries(health.sinks ?? {})
    .filter(([, on]) => !on)
    .map(([name]) => name);
  if (!local && unwired.length) {
    throw new Error(
      `refused: the test API on ${config.endpoints.testApi} reports a sink that is not wired (${unwired.join(', ')}); test mail, pushes or analytics would reach real systems`,
    );
  }

  // The broker's allowlist is the core contract plus the app's (`testApi.contract`), the same table the workers'
  // client uses: an extension route the control calls must be forwarded, anything else is refused there.
  const contract = config.kit.testApi?.contract;
  const broker = await startBroker({
    apiOrigin: config.endpoints.testApi,
    key,
    keyHeader,
    routes: contract ? mergeRoutes(CORE_ROUTES, loadContractRoutes(contract)) : CORE_ROUTES,
    basePath,
    forwardHeaders: ['accept', 'content-type', 'accept-language', ...Object.keys(headers)],
  });
  process.env[ENV.BROKER_URL] = broker.url;
  process.env[ENV.BROKER_TOKEN] = broker.token.reveal();
  delete process.env[ENV.RUNNER_KEY];
  delete process.env[ENV.RUNNER_KEY_FILE];
  // Workers dial loopback only (the broker, their proxies); a person turns it off with `...=off` for a diagnosis.
  process.env[WORKER_PROXY_ENV] ??= 'loopback';

  return async () => {
    let done: RunMeta = meta;
    try {
      done = JSON.parse(fs.readFileSync(runFile, 'utf8')) as RunMeta;
    } catch {
      done = meta;
    }
    try {
      done.cleanup = await control.cleanupRun();
    } catch (error) {
      done.cleanup = { error: error instanceof Error ? error.message : String(error) };
    }
    done.finishedAt = new Date().toISOString();
    writeJson(runFile, done);
    await broker.close();
  };
}
