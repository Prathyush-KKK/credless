// A throwaway project for the runner's tests: a config file (a plain object, so it needs no import of the kit), an
// optional standalone Playwright project with one trivial test, and the kit's own node_modules linked in so
// `@playwright/test` resolves from the project root. Also the CLI as a child process with a minimal environment.
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CLI = path.join(KIT_ROOT, 'src', 'cli.ts');
export const NODE_MODULES = path.join(KIT_ROOT, 'node_modules');

/**
 * A config with a local `selftest` target and a remote `dev` target on a reserved domain. `extraTargets` adds more
 * target lines; a production-shaped one makes the loader refuse the whole config (the overlap check), so it is never
 * in the shared config.
 */
export function configSource(
  options: { key?: string; reportsDir?: string; stagingDir?: string; extraTargets?: string[] } = {},
): string {
  const key = options.key ?? `{ source: 'env' }`;
  return [
    'export default {',
    '  targets: {',
    "    selftest: { web: 'http://127.0.0.1:1', api: 'http://127.0.0.1:1', kind: 'local' },",
    "    dev: { web: 'https://dev.app.example', api: 'https://dev.api.example' },",
    ...(options.extraTargets ?? []).map((line) => `    ${line}`),
    '  },',
    "  production: { domains: ['example.com'], words: ['prod', 'production'] },",
    "  personas: { catalog: 'personas.yaml', addressPattern: '^qa\\\\+[a-z0-9-]+@example\\\\.com$' },",
    `  key: ${key},`,
    `  evidence: { reportsDir: ${JSON.stringify(options.reportsDir ?? 'reports')}${options.stagingDir ? `, stagingDir: ${JSON.stringify(options.stagingDir)}` : ''} },`,
    '};',
    '',
  ].join('\n');
}

const CATALOG = `version: 1
addressTemplate: qa+{ns}-{persona}@example.com
lastNameTemplate: QA-{ns}
defaults: { locale: en-GB, timezone: Europe/London, auth: session }
personas:
  owner: { role: owner, firstName: Olive, purpose: owns things }
`;

export interface TempProject {
  dir: string;
  home: string;
  configFile: string;
  reportsDir: string;
  stagingDir: string;
  /** a minimal environment for the CLI: PATH, a private HOME and the staging override */
  env: Record<string, string>;
  cleanup(): void;
}

export interface TempProjectOptions {
  key?: string;
  /** write a standalone Playwright project (config, one passing test); `spec` replaces the test body */
  playwright?: boolean;
  spec?: string;
  /** the staging dir is inside the temp dir by default; false leaves the override out */
  staging?: boolean;
}

const PASS_HOST = [
  'PATH',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
  'windir',
];

export function makeProject(options: TempProjectOptions = {}): TempProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-runner-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const stagingDir = path.join(dir, 'staging');
  const reportsDir = path.join(dir, 'reports');
  const configFile = path.join(dir, 'credless.config.ts');
  fs.writeFileSync(configFile, configSource({ key: options.key, reportsDir }));
  fs.writeFileSync(path.join(dir, 'personas.yaml'), CATALOG);
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "tmp-project", "private": true, "type": "module" }\n');
  try {
    fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'junction');
  } catch {
    // a project without dependencies: the tests that need Playwright say so
  }
  if (options.playwright) {
    fs.writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      [
        "import { defineConfig } from '@playwright/test';",
        "const dir = process.env.CREDLESS_REPORT_DIR ?? 'test-results';",
        'export default defineConfig({',
        "  testDir: './e2e',",
        "  reporter: [['dot'], ['json', { outputFile: dir + '/results.json' }]],",
        "  outputDir: dir + '/artifacts',",
        '  workers: 1,',
        '});',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(dir, 'e2e'));
    fs.writeFileSync(
      path.join(dir, 'e2e', 'one.spec.ts'),
      [
        "import { expect, test } from '@playwright/test';",
        "test('T01 passes', async () => {",
        options.spec ?? '  expect(1).toBe(1);',
        '});',
        '',
      ].join('\n'),
    );
  }
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
  };
  for (const name of PASS_HOST) if (process.env[name]) env[name] = process.env[name] as string;
  if (options.staging !== false) env.CREDLESS_STAGING_DIR = stagingDir;
  return {
    dir,
    home,
    configFile,
    reportsDir,
    stagingDir,
    env,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Where this machine keeps Playwright's browsers, for a child run that launches one under the temp HOME (which would
 * otherwise hide Playwright's default cache): the variable when set, else that default for the real home.
 */
export function browsersEnv(): Record<string, string> {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set) return { PLAYWRIGHT_BROWSERS_PATH: set };
  const home = os.homedir();
  const where =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'ms-playwright')
        : path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
  return { PLAYWRIGHT_BROWSERS_PATH: where };
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  all: string;
}

/** Run the CLI synchronously in a project with its minimal environment (plus `extraEnv`). */
export function cli(
  project: TempProject,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeout = 120_000,
): CliResult {
  const r: SpawnSyncReturns<string> = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project.dir,
    env: { ...project.env, ...extraEnv },
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    all: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

/** Start the CLI and return the child (for tests that stop it). */
export function cliAsync(project: TempProject, args: string[], extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, [CLI, ...args], {
    cwd: project.dir,
    env: { ...project.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Poll until `check()` is true or the time runs out. */
export async function until(check: () => boolean, ms = 30_000, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return check();
}
