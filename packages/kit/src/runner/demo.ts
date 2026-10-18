// `demo [--headed] [--demo-dir d] [--target t]`: start the demo app, run the quickstart suite against it through `run`,
// print where the contact sheets are. The demo server prints `ready web=<origin> api=<origin>` on ephemeral ports
// (docs/conventions.md §10); those origins reach the run as `DEMO_WEB`/`DEMO_API` and as the kit's origin overrides,
// so the demo's config may hold placeholders.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLI_NAME, KIT_NAME } from '../brand.ts';
import { ENV, EVIDENCE, EXIT, type ExitCode } from '../types.ts';
import { CONFIG_FILE_NAMES } from './project.ts';
import { type RunResult, run } from './run.ts';
import { childEnvironment } from './spawn.ts';

export interface DemoInput {
  headed?: boolean;
  demoDir?: string;
  target?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** seconds to wait for the ready line (default 30) */
  readyTimeoutSeconds?: number;
}

const READY = /ready web=(\S+) api=(\S+)/;

/** `--demo-dir`, else `apps/demo` above `cwd`, else the workspace's `apps/demo` relative to this file. */
export function findDemoDir(cwd: string, explicit?: string): string | null {
  const isDemo = (dir: string) => fs.existsSync(path.join(dir, 'src', 'server.ts'));
  if (explicit) {
    const dir = path.resolve(cwd, explicit);
    return isDemo(dir) ? dir : null;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    for (const candidate of [dir, path.join(dir, 'apps', 'demo')]) if (isDemo(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const workspace = fileURLToPath(new URL('../../../../apps/demo', import.meta.url));
  return isDemo(workspace) ? workspace : null;
}

/** The demo's config file: `e2e/<kit>.config.*` or `<kit>.config.*` in the demo dir. */
export function demoConfig(demoDir: string): string | null {
  for (const dir of [path.join(demoDir, 'e2e'), demoDir]) {
    for (const name of CONFIG_FILE_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** Which target the demo's config calls itself: `demo`, else `selftest`, else its first local target. */
async function pickTarget(configFile: string, wanted?: string): Promise<string | null> {
  if (wanted) return wanted;
  const mod = (await import(pathToFileURL(configFile).href)) as {
    default?: { targets?: Record<string, { kind?: string }> };
  };
  const targets = mod.default?.targets ?? {};
  if (targets.demo) return 'demo';
  if (targets.selftest) return 'selftest';
  return Object.entries(targets).find(([, t]) => t.kind === 'local')?.[0] ?? Object.keys(targets)[0] ?? null;
}

function waitForReady(
  child: ChildProcess,
  seconds: number,
  log: NodeJS.WritableStream,
): Promise<{ web: string; api: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`the demo server printed no "ready web=... api=..." line within ${seconds} s`));
      }
    }, seconds * 1000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = READY.exec(buffer);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ web: m[1] as string, api: m[2] as string });
      }
      log.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`the demo server exited (${code}) before it was ready`));
      }
    });
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

export async function demo(input: DemoInput = {}): Promise<ExitCode> {
  const out = input.stdout ?? process.stdout;
  const err = input.stderr ?? process.stderr;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const say = (m: string) => void err.write(`${CLI_NAME}: ${m}\n`);
  const demoDir = findDemoDir(cwd, input.demoDir);
  if (!demoDir) {
    say(`no demo app found (apps/demo/src/server.ts); pass --demo-dir, or run from the ${KIT_NAME} workspace`);
    return EXIT.USAGE;
  }
  const configFile = demoConfig(demoDir);
  if (!configFile) {
    say(`the demo at ${demoDir} has no ${CONFIG_FILE_NAMES[0]} (e2e/ or its root)`);
    return EXIT.USAGE;
  }
  const target = await pickTarget(configFile, input.target);
  if (!target) {
    say(`${configFile} declares no targets`);
    return EXIT.USAGE;
  }
  const server = spawn(process.execPath, [path.join(demoDir, 'src', 'server.ts')], {
    cwd: demoDir,
    env: childEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const origins = await waitForReady(server, input.readyTimeoutSeconds ?? 30, err);
    say(`demo app ready: web ${origins.web}, api ${origins.api}`);
    let result: RunResult | null = null;
    const code = await run({
      target,
      mode: 'native',
      configPath: configFile,
      cwd: demoDir,
      env: {
        ...env,
        DEMO_WEB: origins.web,
        DEMO_API: origins.api,
        [ENV.WEB_URL]: origins.web,
        [ENV.API_URL]: origins.api,
      },
      stdout: out,
      stderr: err,
      playwrightArgs: input.headed ? ['--headed'] : [],
      onResult: (r) => {
        result = r;
      },
    });
    const kept = result as RunResult | null;
    if (kept) {
      const sheets = path.join(kept.reportDir, EVIDENCE.contactSheets);
      const files = fs.existsSync(sheets) ? fs.readdirSync(sheets).filter((f) => f.endsWith('.png')) : [];
      if (files.length) out.write(`  contact sheets:\n${files.map((f) => `    ${path.join(sheets, f)}`).join('\n')}\n`);
      else out.write('  contact sheets: none written\n');
    }
    return code;
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  } finally {
    server.kill('SIGTERM');
  }
}
