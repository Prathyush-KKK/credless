// What the two release smoke scripts share (smoke-pack.mjs, smoke-registry.mjs): a user's terminal environment, a
// spawn without a shell, the ok/FAIL checklist, and reading where a run kept its evidence.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const KIT = path.join(ROOT, 'packages', 'kit');
const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'));
export const NAME = pkg.name;
export const VERSION = pkg.version;
export const PLAYWRIGHT = pkg.devDependencies['@playwright/test'];
export const PLANT_OK = `${NAME} demo --plant-secret: the planted value was found in the evidence and the run failed, as it should`;

/**
 * The environment of a user's terminal: this one without what `pnpm run` adds (npm_* settings, the workspace's
 * node_modules/.bin on PATH) and without any CREDLESS_* knob, plus a private staging dir for these runs.
 */
export function userEnv(stagingDir) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(npm_|pnpm_|CREDLESS_)/i.test(name) || name === 'INIT_CWD') continue;
    env[name] = value;
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = (env[pathKey] ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !path.resolve(dir).startsWith(path.resolve(ROOT)))
    .join(path.delimiter);
  env.CREDLESS_STAGING_DIR = stagingDir;
  return env;
}

/** Run `command` (a name or `[cmd, ...leading args]`) with `argv`, no shell; output captured. */
export function exec(command, argv, options) {
  const [cmd, ...pre] = Array.isArray(command) ? command : [command];
  const started = Date.now();
  const r = spawnSync(cmd, [...pre, ...argv], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    all: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`,
    seconds: (Date.now() - started) / 1000,
  };
}

/** The checklist: `check` prints one ok/FAIL line (and the tail of `detail` on a failure); `finish` the verdict. */
export function checklist(title) {
  const started = Date.now();
  let total = 0;
  let failed = 0;
  return {
    check(label, ok, detail = '', seconds) {
      total += 1;
      const time = seconds === undefined ? '' : ` (${seconds.toFixed(1)} s)`;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${time}`);
      if (!ok) {
        failed += 1;
        if (detail)
          console.log(
            detail
              .trimEnd()
              .split('\n')
              .slice(-40)
              .map((l) => `        ${l}`)
              .join('\n'),
          );
      }
      return ok;
    },
    /** Print the verdict line and return the exit code (1 when a check failed). */
    finish() {
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        failed
          ? `${title}: ${failed} of ${total} checks failed (${seconds} s)`
          : `${title}: all ${total} checks passed (${seconds} s)`,
      );
      return failed ? 1 : 0;
    },
  };
}

/** The last `summary: <path>` the run printed, and the contact sheets listed after it. */
export function evidenceOf(stdout) {
  const summary = [...stdout.matchAll(/^\s*summary: (.+SUMMARY\.md)\s*$/gm)].at(-1)?.[1] ?? null;
  const sheets = [...stdout.matchAll(/^\s+(\S.*contact-sheet-[^/\\]+\.png)\s*$/gm)].map((m) => m[1]);
  return { summary, sheets };
}

/** The first line of the SUMMARY.md a run printed, `# Run <id>: PASS|FAIL`, or '' when there is none. */
export function verdictOf(stdout) {
  const { summary } = evidenceOf(stdout);
  if (!summary || !fs.existsSync(summary)) return '';
  return fs.readFileSync(summary, 'utf8').split('\n')[0] ?? '';
}
