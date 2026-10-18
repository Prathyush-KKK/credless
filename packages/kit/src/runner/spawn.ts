// How the runner starts anything: `spawn` with an argv array (never a shell), an explicit environment allowlist
// (never `process.env`), and the child's stdio through the redactor. Also where the CLI and the Playwright CLI are
// found, natively and inside the container.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../types.ts';
import { forEachRegisteredSecret, Redactor } from './deps.ts';
import { WORKER_PROXY_ENV } from './shim-policy.ts';

/** Host variables a native run's processes may see: the shell's basics, display and TLS trust, nothing else. */
const PASS_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'PWDEBUG',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);
/** Host variables that are about the host, not the run: dropped from a container's environment. */
const HOST_ONLY = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);
const PASS_PREFIXES = ['PLAYWRIGHT_'];
/** The kit's own knobs a person may set for a run (docs/conventions.md §2), plus the demo's two origins. */
const PASS_KIT = new Set<string>([
  ENV.TRACE,
  ENV.GUARD_OUTSIDE,
  ENV.A11Y,
  ENV.WEB_URL,
  ENV.API_URL,
  ENV.DEMO_KEY_FILE,
  WORKER_PROXY_ENV,
  'DEMO_WEB',
  'DEMO_API',
]);

export interface ChildEnvOptions {
  /** drop the host-only names (the container has its own PATH and HOME) */
  forContainer?: boolean;
  platform?: NodeJS.Platform;
}

/** The environment a run's process gets: the allowlist from `base`, then `extra`. Never a secret, never `process.env`. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
  options: ChildEnvOptions = {},
): Record<string, string> {
  const win = (options.platform ?? process.platform) === 'win32';
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = win ? name.toUpperCase() : name;
    const exact = PASS_EXACT.has(key) && !(options.forContainer && HOST_ONLY.has(key));
    if (exact || PASS_KIT.has(name) || PASS_PREFIXES.some((p) => name.startsWith(p))) out[name] = value;
  }
  Object.assign(out, extra);
  return out;
}

/** What the `docker` CLI itself needs from the host: PATH and HOME to find itself, and its own DOCKER_* settings. */
export function dockerCliEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (
      [
        'PATH',
        'HOME',
        'USERPROFILE',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SYSTEMROOT',
        'COMSPEC',
        'PATHEXT',
        'LOCALAPPDATA',
        'APPDATA',
      ].includes(key) ||
      key.startsWith('DOCKER_')
    )
      out[name] = value;
  }
  return out;
}

/** Playwright's CLI script as seen from the project, or null when it is not installed there. */
export function resolvePlaywrightCli(projectRoot: string): string | null {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  for (const id of ['@playwright/test/cli', 'playwright/cli']) {
    try {
      return require.resolve(id);
    } catch {
      // next
    }
  }
  return null;
}

/** A file beside this module in source (`.ts`) or in the bundle (`.js`, `.mjs`), or null. */
function sibling(name: string): string | null {
  for (const ext of ['ts', 'js', 'mjs']) {
    const file = fileURLToPath(new URL(`./${name}.${ext}`, import.meta.url));
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** The worker shim to `--import`, or null when the build did not emit it (then the run says so and goes on). */
export function shimPath(): string | null {
  return sibling('worker-shim');
}

/** This CLI's entry script: `cli.js` beside the bundle, `../cli.ts` in source, else whatever started this process. */
export function cliEntry(): string {
  const bundled = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (fs.existsSync(bundled) && /[\\/]dist[\\/]cli\.js$/.test(bundled)) return bundled;
  const source = fileURLToPath(new URL('../cli.ts', import.meta.url));
  if (fs.existsSync(source)) return source;
  return process.argv[1] ?? bundled;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** values to redact in the child's output (besides every registered secret) */
  redact?: string[];
  /** the live run folder, whose `.sensitive-hashes` names the codes in play; they are redacted from the output too */
  redactDir?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** told about the child, so a signal handler can stop it */
  onChild?: (child: ChildProcess | null) => void;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Start `cmd argv` with the given environment, output through the redactor; resolves when it exits. */
export function spawnRedacted(cmd: string, argv: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    options.onChild?.(child);
    // Every value this process holds as a secret is replaced in the child's output, whatever the caller listed.
    const values = [...(options.redact ?? [])];
    forEachRegisteredSecret((value) => values.push(value));
    const out = new Redactor({ values, dir: options.redactDir });
    const err = new Redactor({ values, dir: options.redactDir });
    child.stdout?.pipe(out).pipe(options.stdout, { end: false });
    child.stderr?.pipe(err).pipe(options.stderr, { end: false });
    child.once('error', (error) => {
      options.onChild?.(null);
      reject(error);
    });
    child.once('close', (code, signal) => {
      options.onChild?.(null);
      resolve({ code, signal });
    });
  });
}
