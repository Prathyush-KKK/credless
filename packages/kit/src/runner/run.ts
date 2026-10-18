// `run`: the one way a suite starts (plan §4.4, docs/conventions.md §8). In order: the slot is checked before anything
// else; the config is loaded (production and unknown targets are refused there); staging is opened (0700, orphans
// swept) and the lock for target and slot taken; the key is read from the config's key source for a remote target
// only, into one variable of this process that is never exported; it reaches the run as a 0600 file that global setup
// reads and deletes; Playwright runs with an environment allowlist and the worker shim; post-run runs as its own
// process and writes its marker last; a run folder without the marker, or whose marker disagrees with post-run's
// exit, is deleted, never kept. `--twice` runs the suite again and post-run compares the two.
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_NAME } from '../brand.ts';
import {
  DEFAULTS,
  ENV,
  EVIDENCE,
  EXIT,
  type ExitCode,
  PATTERNS,
  type RunConfig,
  type RunMode,
  type RunOptions,
  type SecretValue,
} from '../types.ts';
import { createKeySource, loadProjectConfig, newRunId } from './deps.ts';
import {
  DOCKER_STAGING,
  dockerAvailable,
  dockerOnPath,
  dockerRunArgs,
  imageFor,
  inRun,
  insideContainer,
  inWork,
  playwrightVersion,
} from './docker.ts';
import { acquireRunLock, LockHeldError } from './lock.ts';
import { findProject } from './project.ts';
import { badSlotMessage, checkSlot, resolveSlot, SlotError } from './slot.ts';
import {
  childEnvironment,
  cliEntry,
  dockerCliEnvironment,
  resolvePlaywrightCli,
  shimPath,
  spawnRedacted,
} from './spawn.ts';
import { Cleanup, openStaging } from './staging.ts';

export interface RunResult {
  runId: string;
  reportDir: string;
  code: ExitCode;
}

export interface RunInput extends Omit<RunOptions, 'mode'> {
  mode?: RunMode | 'auto';
  configPath?: string;
  cwd?: string;
  /** the process environment (secrets found in it are taken over and removed); a copy is fine for a local target */
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** more name=value pairs for the run's processes (the demo command's origins) */
  extraEnv?: Record<string, string>;
  /**
   * Where kept evidence goes instead of the config's `evidence.reportsDir` (resolved against `cwd`): the demo run from
   * the installed package keeps it under the person's working directory, not in the temp copy of its project.
   */
  reportsRoot?: string;
  /** told where the evidence went when it was kept */
  onResult?: (result: RunResult) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `--docker`, `--native`, or auto: docker only when its daemon answers. */
export async function resolveMode(
  wanted: RunMode | 'auto',
  env: NodeJS.ProcessEnv,
  say: (m: string) => void,
): Promise<RunMode> {
  if (wanted !== 'auto') return wanted;
  if (await dockerAvailable(env)) return 'docker';
  if (!insideContainer() && dockerOnPath(env))
    say('docker is installed but not running: running natively (start Docker, or pass --native to skip this check)');
  return 'native';
}

export async function run(input: RunInput): Promise<ExitCode> {
  const out = input.stdout ?? process.stdout;
  const err = input.stderr ?? process.stderr;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const say = (m: string) => {
    err.write(`${CLI_NAME}: ${m}\n`);
  };
  const usage = (m: string): ExitCode => {
    say(m);
    return EXIT.USAGE;
  };

  if (input.isolate) return usage('--isolate (a run with no route to the network but the egress proxy) lands in v0.2');
  if (input.workers !== undefined && !(Number.isInteger(input.workers) && input.workers >= 1 && input.workers <= 99)) {
    return usage('--workers must be a number from 1 to 99');
  }
  const waitMinutes = input.waitMinutes ?? DEFAULTS.waitMinutes;
  if (!(Number.isInteger(waitMinutes) && waitMinutes >= 0 && waitMinutes <= 999))
    return usage('--wait takes minutes, 0 to 999');

  // The slot's spelling is checked before anything is read or touched; whether one is needed depends on the target.
  const slotResolution = resolveSlot({ flag: input.slot, env });
  if (slotResolution.slot !== null && !PATTERNS.slot.test(slotResolution.slot))
    return usage(badSlotMessage(slotResolution));

  let project: ReturnType<typeof findProject>;
  try {
    project = findProject(cwd, input.configPath);
  } catch (error) {
    return usage(message(error));
  }
  // The loader never sees a secret, whatever the environment holds.
  const loaderEnv: NodeJS.ProcessEnv = {
    ...env,
    [ENV.TARGET]: input.target,
    [ENV.SLOT]: slotResolution.slot ?? DEFAULTS.slot,
  };
  delete loaderEnv[ENV.RUNNER_KEY];
  delete loaderEnv[ENV.SIGNIN_PASSWORD];
  let config: RunConfig;
  try {
    config = await loadProjectConfig({ configPath: project.configFile, cwd, env: loaderEnv });
  } catch (error) {
    return usage(message(error));
  }
  const local = config.endpoints.kind === 'local';
  let slot: string;
  try {
    slot = checkSlot(slotResolution, { target: input.target, local }).slot;
  } catch (error) {
    if (error instanceof SlotError) return usage(error.message);
    throw error;
  }

  const staging = openStaging({
    env,
    override: env[ENV.STAGING_DIR] ?? config.kit.evidence?.stagingDir,
    cwd: project.root,
  });
  const cleanup = new Cleanup();
  cleanup.install();
  // Whatever is still in staging at the end was never scrubbed to completion: deleted, never kept.
  cleanup.add(() => staging.release());
  let child: ChildProcess | null = null;
  cleanup.add(() => child?.kill('SIGTERM'));

  try {
    let lock: Awaited<ReturnType<typeof acquireRunLock>>;
    try {
      lock = await acquireRunLock(staging.dir, input.target, slot, { waitMs: waitMinutes * 60_000, onWait: say });
    } catch (error) {
      if (error instanceof LockHeldError) return usage(error.message);
      throw error;
    }
    cleanup.add(() => lock.release());

    const mode = await resolveMode(input.mode ?? 'auto', env, say);
    const pwVersion = playwrightVersion(project.root);
    if (!pwVersion) return usage(`@playwright/test is not installed in ${project.root} (npm i -D @playwright/test)`);
    const image = imageFor(pwVersion, config.kit.docker?.image);
    const entry = cliEntry();
    const containerCli = mode === 'docker' ? inWork(project.root, entry) : null;
    const pwCli = mode === 'native' ? resolvePlaywrightCli(project.root) : null;
    if (mode === 'native' && !pwCli) return usage(`Playwright's CLI is not resolvable from ${project.root}`);
    if (mode === 'docker' && !containerCli) {
      return usage(
        `docker mode needs the ${CLI_NAME} CLI inside the project (it runs from ${entry}): install it as a dev dependency, or pass --native`,
      );
    }
    if (mode === 'docker' && !image.pinned)
      say(`image ${image.tag} is unpinned (no digest in the runner's table for Playwright ${pwVersion})`);

    // Secrets. Nothing inherited from the caller reaches anything this process starts, whatever the target: the
    // sign-in password is taken over into a file; the key is read from the key source for a remote target only.
    const password = env[ENV.SIGNIN_PASSWORD]?.trim() || null;
    delete env[ENV.SIGNIN_PASSWORD];
    let key: SecretValue | null = null;
    if (!local) {
      if (!config.hasKeySource || !config.kit.key)
        return usage(`no key source for ${input.target}: add \`key\` to the config (env, file, exec or keyring)`);
      try {
        key = await createKeySource(config.kit.key).read();
      } catch (error) {
        return usage(
          `no runner key (${config.kit.key.source} source): ${message(error)}. Never paste it into a session`,
        );
      }
    }
    delete env[ENV.RUNNER_KEY];
    const redact = [key?.reveal(), password].filter((v): v is string => Boolean(v));

    const reportsRoot = input.reportsRoot
      ? path.resolve(cwd, input.reportsRoot)
      : path.resolve(project.root, config.kit.evidence?.reportsDir ?? DEFAULTS.reportsDir);
    fs.mkdirSync(reportsRoot, { recursive: true });
    // Keys the HMAC list of codes the scrubber removes; held by this process, never written.
    const evidenceKey = crypto.randomBytes(32).toString('hex');
    const passwordFile = password ? staging.secretFile('password', password) : null;
    const shim = mode === 'native' ? shimPath() : 'in-container';
    if (!shim) say('worker shim not found beside the runner: workers run without the advisory socket guard');
    const onChild = (c: ChildProcess | null): void => {
      child = c;
    };
    const io = { stdout: out, stderr: err, redact, onChild };
    const stagingForRun = mode === 'docker' ? DOCKER_STAGING : staging.dir;
    const commonEnv: Record<string, string> = {
      [ENV.TARGET]: input.target,
      [ENV.SLOT]: slot,
      [ENV.STAGING_DIR]: stagingForRun,
    };

    /** One `playwright test` with its own run id and key file; returns Playwright's exit code. */
    const runOnce = async (runId: string): Promise<number> => {
      const dir = staging.runDir(runId);
      const keyFile = key ? staging.secretFile(`key-${runId}`, key.reveal()) : null;
      const runEnv: Record<string, string> = {
        ...commonEnv,
        [ENV.RUN_ID]: runId,
        [ENV.REPORT_DIR]: inRun(mode, staging.dir, dir),
      };
      if (keyFile) runEnv[ENV.RUNNER_KEY_FILE] = inRun(mode, staging.dir, keyFile);
      if (passwordFile) runEnv[ENV.SIGNIN_PASSWORD_FILE] = inRun(mode, staging.dir, passwordFile);
      if (input.workers) runEnv[ENV.WORKERS] = String(input.workers);
      const pwArgs = ['test', ...(input.project ? ['--project', input.project] : []), ...(input.playwrightArgs ?? [])];
      if (mode === 'native') {
        const base = childEnvironment(env, { ...input.extraEnv, ...runEnv, [ENV.EVIDENCE_KEY]: evidenceKey });
        if (shim)
          base.NODE_OPTIONS = [base.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(' ');
        const result = await spawnRedacted(process.execPath, [pwCli as string, ...pwArgs], {
          cwd: project.root,
          env: base,
          ...io,
          // codes the fixtures hand out during the run (`.sensitive-hashes`) are redacted from the suite's output too
          redactDir: dir,
        });
        return result.code ?? 128;
      }
      // The evidence key travels by name (`-e NAME`): docker reads it from its own environment, off the command line.
      const containerEnv = childEnvironment(env, { ...input.extraEnv, ...runEnv }, { forContainer: true });
      const args = dockerRunArgs({
        image: image.ref,
        projectRoot: project.root,
        stagingDir: staging.dir,
        env: containerEnv,
        passNames: [ENV.EVIDENCE_KEY],
        ipcHost: true,
        command: ['node', containerCli as string, '__suite', ...pwArgs],
      });
      const result = await spawnRedacted('docker', args, {
        cwd: project.root,
        env: { ...dockerCliEnvironment(env), [ENV.EVIDENCE_KEY]: evidenceKey },
        ...io,
      });
      return result.code ?? 128;
    };

    const runA = newRunId();
    let suiteExit = await runOnce(runA);
    let runB: string | null = null;
    if (input.twice) {
      runB = newRunId();
      const second = await runOnce(runB);
      if (second !== 0) suiteExit = second;
    }

    // Post-run where the tests ran, as its own process: it scrubs by value, so the values go to it as one more file
    // in staging that it reads and deletes as it starts.
    const scrubFile = staging.secretFile('scrub', ...redact);
    const postArgs = [
      '__post-run',
      inRun(mode, staging.dir, path.join(staging.dir, runA)),
      '--suite-exit',
      String(suiteExit),
    ];
    if (runB) postArgs.push('--compare', inRun(mode, staging.dir, path.join(staging.dir, runB)));
    // What the scrub treats as a session cookie, a credential header and a one-time code comes from the config.
    const signals = config.kit.signals;
    const cookieNames = [...(signals?.sessionCookies ?? []), ...(signals?.csrf ? [signals.csrf.cookie] : [])];
    const headerNames = [config.kit.testApi?.keyHeader, signals?.csrf?.header].filter((h): h is string => Boolean(h));
    if (cookieNames.length) postArgs.push('--cookie-names', cookieNames.join(','));
    if (headerNames.length) postArgs.push('--header-names', headerNames.join(','));
    if (config.kit.evidence?.codeShape) postArgs.push('--code-shape', config.kit.evidence.codeShape);
    const postEnv: Record<string, string> = {
      ...commonEnv,
      [ENV.RUN_ID]: runA,
      [ENV.REPORT_DIR]: inRun(mode, staging.dir, path.join(staging.dir, runA)),
      [ENV.SCRUB_VALUES_FILE]: inRun(mode, staging.dir, scrubFile),
    };
    let postExit: number;
    if (mode === 'native') {
      const base = childEnvironment(env, { ...input.extraEnv, ...postEnv, [ENV.EVIDENCE_KEY]: evidenceKey });
      postExit =
        (await spawnRedacted(process.execPath, [entry, ...postArgs], { cwd: project.root, env: base, ...io })).code ??
        128;
    } else {
      const args = dockerRunArgs({
        image: image.ref,
        projectRoot: project.root,
        stagingDir: staging.dir,
        env: childEnvironment(env, { ...input.extraEnv, ...postEnv }, { forContainer: true }),
        passNames: [ENV.EVIDENCE_KEY],
        command: ['node', containerCli as string, ...postArgs],
      });
      postExit =
        (
          await spawnRedacted('docker', args, {
            cwd: project.root,
            env: { ...dockerCliEnvironment(env), [ENV.EVIDENCE_KEY]: evidenceKey },
            ...io,
          })
        ).code ?? 128;
    }

    // Kept only when post-run finished: exit 0 or 1 AND its marker says the same. Anything else (exit 4, a crash, a
    // kill, running out of memory) means the evidence may be unscrubbed: the cleanup deletes it.
    if ((postExit !== EXIT.PASS && postExit !== EXIT.FAIL) || !staging.markerSays(runA, postExit)) {
      say(`${runA}: FAIL. Post-run did not finish (exit ${postExit}): the evidence was deleted, not kept.`);
      return EXIT.EVIDENCE_UNSAFE;
    }
    const kept = path.join(reportsRoot, runA);
    staging.keep(runA, kept);
    if (runB) staging.keep(runB, path.join(reportsRoot, runB));
    const code: ExitCode = suiteExit === 0 && postExit === EXIT.PASS ? EXIT.PASS : EXIT.FAIL;
    out.write(
      `\n${CLI_NAME} ${runA}: ${code === EXIT.PASS ? 'PASS' : 'FAIL'} (target ${input.target}, slot ${slot})\n  summary: ${path.join(kept, EVIDENCE.summary)}\n`,
    );
    input.onResult?.({ runId: runA, reportDir: kept, code });
    return code;
  } finally {
    cleanup.run();
  }
}
