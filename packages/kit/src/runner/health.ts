// `health --target t`: is the test API on for this target, are its sinks wired? Prints what the backend says, never
// the key. `seed --target t [--slot x] [--workers n]`: create (or keep) every persona's account in a slot's namespaces
// and reset them to their baseline; the run does this per worker on its own, this is for checking a target by hand.
// Both read the key from the config's key source into this process only (no browser, no worker, no handover).
import path from 'node:path';
import { CLI_NAME } from '../brand.ts';
import { CORE_ROUTES, DEFAULTS, ENV, EXIT, type ExitCode, type Health, type RunConfig } from '../types.ts';
import {
  Control,
  createKeySource,
  loadCatalog,
  loadProjectConfig,
  mailSinkFor,
  namespaceFor,
  TestApiClient,
} from './deps.ts';
import { missingKeyMessage } from './messages.ts';
import { findProject } from './project.ts';
import { checkSlot, resolveSlot, SlotError } from './slot.ts';

export interface TargetCommandInput {
  target: string;
  slot?: string;
  workers?: number;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface Prepared {
  config: RunConfig;
  root: string;
  slot: string;
  api: TestApiClient;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Config, slot and a direct client with the key: shared by health and seed. Returns an exit code on a usage error. */
async function prepare(
  input: TargetCommandInput,
  needsSlot: boolean,
  say: (m: string) => void,
): Promise<Prepared | ExitCode> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const resolution = resolveSlot({ flag: input.slot, env });
  let project: ReturnType<typeof findProject>;
  try {
    project = findProject(cwd, input.configPath);
  } catch (error) {
    say(message(error));
    return EXIT.USAGE;
  }
  const loaderEnv: NodeJS.ProcessEnv = {
    ...env,
    [ENV.TARGET]: input.target,
    [ENV.SLOT]: resolution.slot ?? DEFAULTS.slot,
  };
  delete loaderEnv[ENV.RUNNER_KEY];
  delete loaderEnv[ENV.SIGNIN_PASSWORD];
  let config: RunConfig;
  try {
    config = await loadProjectConfig({ configPath: project.configFile, cwd, env: loaderEnv });
  } catch (error) {
    say(message(error));
    return EXIT.USAGE;
  }
  let slot: string;
  try {
    slot = checkSlot(resolution, {
      target: input.target,
      local: config.endpoints.kind === 'local',
      needsNone: !needsSlot,
    }).slot;
  } catch (error) {
    if (error instanceof SlotError) {
      say(error.message);
      return EXIT.USAGE;
    }
    throw error;
  }
  if (!config.kit.key) {
    say(`no key source for ${input.target}: add \`key\` to the config`);
    return EXIT.USAGE;
  }
  let key: Awaited<ReturnType<ReturnType<typeof createKeySource>['read']>>;
  try {
    key = await createKeySource(config.kit.key).read();
  } catch (error) {
    say(missingKeyMessage(config.kit.key.source, message(error)));
    return EXIT.USAGE;
  }
  delete env[ENV.RUNNER_KEY];
  const api = new TestApiClient({
    apiOrigin: config.endpoints.testApi,
    transport: { kind: 'direct', key },
    routes: CORE_ROUTES,
    basePath: config.kit.testApi?.basePath,
    keyHeader: config.kit.testApi?.keyHeader,
    headers: config.kit.testApi?.headers,
  });
  return { config, root: project.root, slot, api };
}

export async function health(input: TargetCommandInput): Promise<ExitCode> {
  const out = input.stdout ?? process.stdout;
  const err = input.stderr ?? process.stderr;
  const say = (m: string) => void err.write(`${CLI_NAME}: ${m}\n`);
  const prepared = await prepare(input, false, say);
  if (typeof prepared === 'number') return prepared;
  const { config, api } = prepared;
  try {
    const { data } = await api.call<Health>('health');
    const report = {
      target: config.target,
      api: config.endpoints.testApi,
      environment: data.environment,
      keyId: data.keyId,
      version: data.version ?? null,
      sinks: data.sinks,
      extensions: data.extensions ?? [],
    };
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    const unwired = Object.entries(data.sinks ?? {})
      .filter(([, on]) => !on)
      .map(([name]) => name);
    if (unwired.length && config.endpoints.kind !== 'local') {
      say(`sink not wired: ${unwired.join(', ')}; real runs are refused until every sink reports true`);
      return EXIT.FAIL;
    }
    return EXIT.PASS;
  } catch (error) {
    say(message(error));
    return EXIT.FAIL;
  }
}

export async function seed(input: TargetCommandInput): Promise<ExitCode> {
  const out = input.stdout ?? process.stdout;
  const err = input.stderr ?? process.stderr;
  const say = (m: string) => void err.write(`${CLI_NAME}: ${m}\n`);
  if (input.workers !== undefined && !(Number.isInteger(input.workers) && input.workers >= 1 && input.workers <= 99)) {
    say('--workers must be a number from 1 to 99');
    return EXIT.USAGE;
  }
  const prepared = await prepare(input, true, say);
  if (typeof prepared === 'number') return prepared;
  const { config, root, slot, api } = prepared;
  try {
    const catalog = loadCatalog(path.resolve(root, config.kit.personas.catalog));
    const all = Object.keys(catalog.personas);
    const workers = input.workers ?? config.kit.personas.workers ?? DEFAULTS.workers;
    for (let i = 0; i < workers; i += 1) {
      const ns = namespaceFor(slot, i);
      const control = new Control({
        api,
        catalog,
        ns,
        runId: config.runId,
        webOrigin: config.endpoints.web,
        mail: await mailSinkFor(api, config.kit.mail, { ns, catalog }),
      });
      if (i === 0) await control.health();
      const ensured = await control.ensure(all);
      await control.reset(all);
      out.write(`${ns}: ${ensured.map((p) => `${p.handle}=${p.userId}${p.created ? ' (new)' : ''}`).join(' ')}\n`);
    }
    return EXIT.PASS;
  } catch (error) {
    say(message(error));
    return EXIT.FAIL;
  }
}
