// `demo [--headed] [--plant-secret] [--reports-dir d] [--demo-dir d] [--target t]`: start the demo app, run the
// quickstart suite against it through `run`, print where the summary and the contact sheets are.
//
// One source, two layouts. apps/demo is the demo; in the workspace (or with `--demo-dir`) it runs from there as it is.
// The published package carries the same demo, built by scripts/build-demo.ts: the server bundled to JavaScript in
// dist/demo/ (Node strips no types under node_modules) and the e2e project in demo/ with its imports pointing at the
// package. Playwright transforms nothing under node_modules either, so that project is copied to a fresh temp dir
// whose node_modules links back to the installed kit and its @playwright/test; the evidence is kept under the working
// directory (`./credless-demo/reports/<run id>/`) and the temp copy goes when the demo stops.
//
// The demo server prints `ready web=<origin> api=<origin>` on ephemeral ports (docs/conventions.md §10); those origins
// reach the run as `DEMO_WEB`/`DEMO_API` and as the kit's origin overrides, so the demo's config may hold
// placeholders. The demo's stand-in runner key is written by the server (`--write-key`, mode 0600) into a private temp
// dir that goes when the demo stops; the run's config reads it from there (`CREDLESS_DEMO_KEY_FILE`), the same way the
// kit's own self-tests do.
//
// `--plant-secret` is the acceptance test of the evidence pipeline: one more spec writes the demo's stand-in sign-in
// password into the test output on purpose. The scrub must redact and count it, SUMMARY.md must say LEAK and the run
// must exit 1; only then does the command say so and exit 0.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLI_NAME, KIT_NAME } from '../brand.ts';
import { ENV, EVIDENCE, EXIT, type ExitCode } from '../types.ts';
import { chromiumInstallCommand, missingBrowsers } from './browsers.ts';
import { packageRoot } from './deps.ts';
import { playwrightVersion } from './docker.ts';
import { CONFIG_FILE_NAMES } from './project.ts';
import { type RunResult, run } from './run.ts';
import { childEnvironment } from './spawn.ts';

export interface DemoInput {
  headed?: boolean;
  /** add the spec that plants the stand-in sign-in password; succeed only when the run fails with a LEAK */
  plantSecret?: boolean;
  /** where kept evidence goes; default: the demo config's (source), `./credless-demo/reports` (package) */
  reportsDir?: string;
  demoDir?: string;
  target?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** seconds to wait for the ready line (default 30) */
  readyTimeoutSeconds?: number;
}

/**
 * Set for the run by `--plant-secret` (through `extraEnv`, so no allowlist needs it); the demo's Playwright config
 * reads it and adds the plant project. A demo variable like `DEMO_WEB`, not a kit knob.
 */
export const PLANT_SECRET_ENV = 'DEMO_PLANT_SECRET';

/** Where the packaged demo keeps its evidence, under the working directory. */
export const DEMO_EVIDENCE_DIR = path.join(`${KIT_NAME}-demo`, 'reports');

/** What `--plant-secret` prints when the protection worked. */
export const PLANT_OK = `${CLI_NAME} demo --plant-secret: the planted value was found in the evidence and the run failed, as it should`;

const READY = /ready web=(\S+) api=(\S+)/;

/** The pieces of one demo run: the e2e project's config, the server to start, its stand-in secrets. */
export interface DemoLayout {
  /** `source`: apps/demo as it is; `package`: the published copy, staged in a temp dir */
  kind: 'source' | 'package';
  configFile: string;
  /** apps/demo/src/server.ts, or dist/demo/server.js from the package */
  server: string;
  /** the directory the server and the run start in */
  dir: string;
  /** the demo's fake-secrets.json (the stand-in sign-in password) */
  secretsFile: string;
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

/** The kit's package root (packages/kit in the workspace, node_modules/credless when installed). */
function kitRoot(): string {
  return packageRoot(path.dirname(fileURLToPath(import.meta.url)));
}

/**
 * The workspace's apps/demo when this CLI runs from the kit's own checkout (source or build), else null. Never found by
 * walking up from the working directory, and never from a kit under node_modules: a person's project may well have an
 * apps/demo of its own, and it is not this demo.
 */
export function workspaceDemo(root: string = kitRoot()): string | null {
  if (root.split(/[\\/]/).includes('node_modules')) return null;
  const dir = path.resolve(root, '..', '..', 'apps', 'demo');
  return fs.existsSync(path.join(dir, 'src', 'server.ts')) && demoConfig(dir) ? dir : null;
}

/** `--demo-dir` when it holds a demo server, else the workspace's apps/demo, else null. */
export function findDemoDir(cwd: string, explicit?: string): string | null {
  if (!explicit) return workspaceDemo();
  const dir = path.resolve(cwd, explicit);
  return fs.existsSync(path.join(dir, 'src', 'server.ts')) ? dir : null;
}

/** The demo the build put into the package (demo/ and dist/demo/), or null when this copy has none. */
export function packagedDemo(
  root: string = kitRoot(),
): { project: string; server: string; secretsFile: string } | null {
  const project = path.join(root, 'demo');
  const server = path.join(root, 'dist', 'demo', 'server.js');
  const secretsFile = path.join(root, 'dist', 'demo', 'fake-secrets.json');
  return demoConfig(project) && fs.existsSync(server) && fs.existsSync(secretsFile)
    ? { project, server, secretsFile }
    : null;
}

/**
 * Copy the packaged e2e project to a fresh temp dir and give it a node_modules with two links: the kit, and the
 * @playwright/test the kit itself resolves, so the config, the specs and the kit's fixtures share one Playwright. Links
 * per package rather than one to the whole node_modules: that works where the kit is nested, in pnpm's store and in
 * npx's cache alike. Directory junctions on Windows need no privilege. Throws with a message for the person.
 */
export function stageProject(packagedProject: string, root: string = kitRoot(), tmpRoot = os.tmpdir()): string {
  let playwright: string;
  try {
    const require = createRequire(path.join(root, 'package.json'));
    playwright = path.dirname(fs.realpathSync(require.resolve('@playwright/test/package.json')));
  } catch {
    throw new Error(`@playwright/test is not installed next to ${KIT_NAME}: npm i -D @playwright/test`);
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${KIT_NAME}-demo-project-`));
  try {
    fs.cpSync(packagedProject, dir, { recursive: true });
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(modules, '@playwright'), { recursive: true });
    fs.symlinkSync(fs.realpathSync(root), path.join(modules, KIT_NAME), 'junction');
    fs.symlinkSync(playwright, path.join(modules, '@playwright', 'test'), 'junction');
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
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

/** The first file under `dir` whose bytes contain `value`, relative to `dir`; null when none does. Never prints it. */
function fileHolding(dir: string, value: string): string | null {
  const needle = Buffer.from(value);
  const walk = (current: string): string | null => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.isFile() && fs.readFileSync(full).includes(needle)) return path.relative(dir, full);
    }
    return null;
  };
  return walk(dir);
}

/**
 * Why `--plant-secret` did not get what it asked for, or null when it did: evidence kept, exit 1, SUMMARY.md says FAIL
 * with a LEAK line, scan.json counted the value, and no kept file holds it any more.
 */
export function plantVerdict(code: ExitCode, kept: RunResult | null, planted: string | null): string | null {
  if (!planted) return 'the demo has no stand-in sign-in password to plant (fake-secrets.json)';
  if (code === EXIT.EVIDENCE_UNSAFE) return 'the evidence was not safe to keep (exit 4) and was deleted';
  if (!kept) return `no evidence was kept (exit ${code})`;
  if (code !== EXIT.FAIL) return `the run exited ${code}, not 1`;
  let summary = '';
  try {
    summary = fs.readFileSync(path.join(kept.reportDir, EVIDENCE.summary), 'utf8');
  } catch {
    return `no ${EVIDENCE.summary} in ${kept.reportDir}`;
  }
  if (!/^# Run \S+: FAIL$/m.test(summary)) return `${EVIDENCE.summary} does not say FAIL`;
  if (!/^- LEAK: /m.test(summary)) return `${EVIDENCE.summary} has no LEAK line`;
  let counted = 0;
  try {
    counted =
      (JSON.parse(fs.readFileSync(path.join(kept.reportDir, EVIDENCE.scan), 'utf8')) as { secretValues?: number })
        .secretValues ?? 0;
  } catch {
    counted = 0;
  }
  if (counted < 1) return `${EVIDENCE.scan} counted no secret value`;
  const holder = fileHolding(kept.reportDir, planted);
  if (holder) return `the planted value is still in ${holder}`;
  return null;
}

export async function demo(input: DemoInput = {}): Promise<ExitCode> {
  const out = input.stdout ?? process.stdout;
  const err = input.stderr ?? process.stderr;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const say = (m: string) => void err.write(`${CLI_NAME}: ${m}\n`);
  const temps: string[] = [];
  let server: ChildProcess | null = null;
  // Also on process.exit(): run's signal handlers end the process with it, and nothing after that runs a `finally`.
  const cleanup = () => {
    server?.kill('SIGTERM');
    server = null;
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', cleanup);
  try {
    let layout: DemoLayout;
    const sourceDir = findDemoDir(cwd, input.demoDir);
    if (input.demoDir && !sourceDir) {
      say(`no demo app at ${path.resolve(cwd, input.demoDir)} (src/server.ts)`);
      return EXIT.USAGE;
    }
    if (sourceDir) {
      const configFile = demoConfig(sourceDir);
      if (!configFile) {
        say(`the demo at ${sourceDir} has no ${CONFIG_FILE_NAMES[0]} (e2e/ or its root)`);
        return EXIT.USAGE;
      }
      layout = {
        kind: 'source',
        configFile,
        server: path.join(sourceDir, 'src', 'server.ts'),
        dir: sourceDir,
        secretsFile: path.join(sourceDir, 'src', 'fake-secrets.json'),
      };
    } else {
      const packaged = packagedDemo();
      if (!packaged) {
        say(`this copy of ${KIT_NAME} has no demo (demo/ and dist/demo/ are missing); reinstall it`);
        return EXIT.USAGE;
      }
      let project: string;
      try {
        project = stageProject(packaged.project);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.USAGE;
      }
      temps.push(project);
      layout = {
        kind: 'package',
        configFile: demoConfig(project) as string,
        server: packaged.server,
        dir: project,
        secretsFile: packaged.secretsFile,
      };
      say(`running the demo that ships with ${KIT_NAME}; its specs: ${path.join(packaged.project, 'e2e')}`);
    }

    // Before anything starts: without Chromium the run would fail in every test with Playwright's own long message.
    const projectRoot = path.dirname(layout.configFile);
    const missing = await missingBrowsers(projectRoot, ['chromium']);
    if (missing === null) {
      say(`@playwright/test does not load from ${projectRoot}: npm i -D @playwright/test`);
      return EXIT.USAGE;
    }
    if (missing.length) {
      say(
        `Playwright's Chromium is not installed. Install it, then run the demo again:\n\n  ${chromiumInstallCommand(playwrightVersion(projectRoot))}\n`,
      );
      return EXIT.USAGE;
    }

    const target = await pickTarget(layout.configFile, input.target);
    if (!target) {
      say(`${layout.configFile} declares no targets`);
      return EXIT.USAGE;
    }
    // mkdtemp makes the dir 0700; the server writes the key file 0600 inside it, never overwriting.
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), `${KIT_NAME}-demo-`));
    temps.push(keyDir);
    const keyFile = path.join(keyDir, 'runner.key');
    const child = spawn(process.execPath, [layout.server, '--write-key', keyFile], {
      cwd: layout.dir,
      env: childEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server = child;
    const origins = await waitForReady(child, input.readyTimeoutSeconds ?? 30, err);
    say(`demo app ready: web ${origins.web}, api ${origins.api}`);
    // The one sign-in test types the demo's stand-in password; it goes to `run` the way a real one does (taken over
    // into a 0600 file in staging, never a worker's environment). Missing from the file: the test fails, nothing else.
    const fake = JSON.parse(fs.readFileSync(layout.secretsFile, 'utf8')) as { signinPassword?: string };
    const reportsRoot = input.reportsDir
      ? path.resolve(cwd, input.reportsDir)
      : layout.kind === 'package'
        ? path.resolve(cwd, DEMO_EVIDENCE_DIR)
        : undefined;
    let result: RunResult | null = null;
    const code = await run({
      target,
      mode: 'native',
      configPath: layout.configFile,
      cwd: layout.dir,
      env: {
        ...env,
        DEMO_WEB: origins.web,
        DEMO_API: origins.api,
        [ENV.WEB_URL]: origins.web,
        [ENV.API_URL]: origins.api,
        [ENV.DEMO_KEY_FILE]: keyFile,
        ...(fake.signinPassword ? { [ENV.SIGNIN_PASSWORD]: fake.signinPassword } : {}),
      },
      ...(input.plantSecret ? { extraEnv: { [PLANT_SECRET_ENV]: '1' } } : {}),
      ...(reportsRoot ? { reportsRoot } : {}),
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
    if (!input.plantSecret) return code;
    // The run never started (a lock held, a bad flag): nothing was planted, so nothing was proven either way.
    if (code === EXIT.USAGE) return code;
    const reason = plantVerdict(code, kept, fake.signinPassword ?? null);
    if (reason === null) {
      out.write(`\n${PLANT_OK}\n`);
      return EXIT.PASS;
    }
    out.write(`\n${CLI_NAME} demo --plant-secret: the protection did NOT trigger: ${reason}\n`);
    return EXIT.FAIL;
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}
