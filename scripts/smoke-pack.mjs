#!/usr/bin/env node
// `pnpm smoke:pack`: the package as a real user gets it, checked before every release (no CI runs for this repo, so
// this is the gate). It builds the kit, packs it with pnpm into a temp dir, installs the tarball and the pinned
// @playwright/test into a blank npm project, and drives the CLI through node_modules/.bin/credless, the symlink npm
// makes and users hit: --help, version, init then doctor --offline, demo (PASS, contact sheet kept), demo
// --plant-secret (the expected line), a real suite run inside the blank project itself (npm init -y makes it
// CommonJS, which is what most users have), and the same demo through npx from an empty directory.
//
//   node scripts/smoke-pack.mjs [--no-build] [--skip-npx] [--keep]
//
// No shell anywhere (argv arrays, npm and pnpm started as Node scripts where they can be found); every temp dir is
// removed at the end, pass or fail, unless --keep. Exit 1 when a check fails. The demo's values are stand-ins; the
// planted one is only ever compared, never printed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageManager as tool } from './package-managers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = path.join(ROOT, 'packages', 'kit');
const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'));
const NAME = pkg.name;
const VERSION = pkg.version;
const PLAYWRIGHT = pkg.devDependencies['@playwright/test'];
const PLANT_OK = `${NAME} demo --plant-secret: the planted value was found in the evidence and the run failed, as it should`;

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--no-build', '--skip-npx', '--keep'].includes(arg)) {
    console.error(`smoke-pack: unknown option ${arg} (--no-build, --skip-npx, --keep)`);
    process.exit(2);
  }
}

/**
 * The environment of a user's terminal: this one without what `pnpm run` adds (npm_* settings, the workspace's
 * node_modules/.bin on PATH) and without any CREDLESS_* knob, plus a private staging dir for these runs.
 */
function userEnv(stagingDir) {
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

function exec(command, argv, options) {
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

const results = [];
let failed = 0;
function check(label, ok, detail = '', seconds) {
  const time = seconds === undefined ? '' : ` (${seconds.toFixed(1)} s)`;
  results.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${time}`);
  console.log(results.at(-1));
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
}

/** The last `summary: <path>` the run printed, and the contact sheets listed after it. */
function evidenceOf(stdout) {
  const summary = [...stdout.matchAll(/^\s*summary: (.+SUMMARY\.md)\s*$/gm)].at(-1)?.[1] ?? null;
  const sheets = [...stdout.matchAll(/^\s+(\S.*contact-sheet-[^/\\]+\.png)\s*$/gm)].map((m) => m[1]);
  return { summary, sheets };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-smoke-`));
const packDir = path.join(tmp, 'pack');
const project = path.join(tmp, 'project');
const empty = path.join(tmp, 'empty');
const staging = path.join(tmp, 'staging');
for (const dir of [packDir, project, empty]) fs.mkdirSync(dir);
const env = userEnv(staging);
const started = Date.now();
let npxCache = null;
let npxBefore = new Set();

console.log(`smoke:pack  ${NAME} ${VERSION}, @playwright/test ${PLAYWRIGHT}, node ${process.version}`);
try {
  await run();
} finally {
  if (npxCache) {
    // npx keeps one cache folder per package spec; this run's spec was a temp path, so its folder is never reused
    for (const name of fs.existsSync(npxCache) ? fs.readdirSync(npxCache) : []) {
      if (!npxBefore.has(name)) fs.rmSync(path.join(npxCache, name), { recursive: true, force: true });
    }
  }
  if (args.has('--keep')) console.log(`  kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
const total = results.length;
const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  failed
    ? `smoke:pack: ${failed} of ${total} checks failed (${seconds} s)`
    : `smoke:pack: all ${total} checks passed (${seconds} s)`,
);
process.exit(failed ? 1 : 0);

async function run() {
  if (!args.has('--no-build')) {
    const r = exec(tool('pnpm'), ['--filter', './packages/kit', 'build'], { cwd: ROOT, env: process.env });
    if (!check('build packages/kit (tsdown, then the demo)', r.status === 0, r.all, r.seconds)) return;
  }

  const packed = exec(tool('pnpm'), ['pack', '--pack-destination', packDir], { cwd: KIT, env: process.env });
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!check(`pnpm pack: ${tgz ?? 'no tarball'}`, packed.status === 0 && Boolean(tgz), packed.all, packed.seconds)) {
    return;
  }
  const tarball = path.join(packDir, tgz);

  exec(tool('npm'), ['init', '-y'], { cwd: project, env });
  const installed = exec(
    tool('npm'),
    ['i', '--ignore-scripts', '--no-audit', '--no-fund', tarball, `@playwright/test@${PLAYWRIGHT}`],
    { cwd: project, env },
  );
  if (!check(`npm i <tgz> @playwright/test@${PLAYWRIGHT} in a blank project`, installed.status === 0, installed.all)) {
    return;
  }

  const installedKit = path.join(project, 'node_modules', NAME);
  const shipped = [
    'LICENSE',
    'README.md',
    'dist/cli.js',
    'dist/demo/server.js',
    'dist/demo/app.html',
    'dist/demo/fake-secrets.json',
    'demo/package.json',
    'demo/e2e/credless.config.mts',
    'demo/e2e/playwright.config.mts',
    'demo/e2e/plant-secret.spec.mts',
    'demo/contract/demo.openapi.yaml',
    'templates/credless.config.ts',
    'contract/core.openapi.yaml',
    'contract/BACKEND-BRIEF.md',
  ];
  const missing = shipped.filter((f) => !fs.existsSync(path.join(installedKit, f)));
  check(
    'the package ships dist/, dist/demo/, demo/, templates/, contract/, LICENSE',
    missing.length === 0,
    missing.join('\n'),
  );

  // The path users hit: npm's symlink, started by its shebang. Windows has .cmd shims instead; there the entry
  // script itself is started with node (the symlink case is POSIX-only).
  const link = path.join(project, 'node_modules', '.bin', NAME);
  const win = process.platform === 'win32';
  const bin = win ? [process.execPath, path.join(installedKit, 'dist', 'cli.js')] : [link];
  if (!win) check(`node_modules/.bin/${NAME} is npm's symlink`, fs.lstatSync(link).isSymbolicLink());
  const cli = (argv, cwd = project) => exec(bin, argv, { cwd, env });

  const help = cli(['--help']);
  check(
    `${NAME} --help prints the usage`,
    help.status === 0 && help.stdout.includes(`Usage: ${NAME} <command>`),
    help.all,
  );

  const runHelp = cli(['help', 'run']);
  const typo = cli(['rnu']);
  check(
    `${NAME} help run prints its usage and examples; a typo gets a suggestion`,
    runHelp.status === 0 &&
      runHelp.stdout.startsWith(`Usage: ${NAME} run --target`) &&
      runHelp.stdout.includes('Examples:') &&
      typo.status === 2 &&
      typo.stderr.includes('did you mean "run"?'),
    `${runHelp.all}\n${typo.all}`,
  );

  // the slot file goes under a throwaway config home, never the real one
  const slotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-slot-'));
  const slotEnv = { ...env, XDG_CONFIG_HOME: slotHome, APPDATA: slotHome };
  const setSlot = exec(bin, ['slot', 'q'], { cwd: project, env: slotEnv });
  const showSlot = exec(bin, ['slot'], { cwd: project, env: slotEnv });
  check(
    `${NAME} slot q writes the slot file and ${NAME} slot reads it back`,
    setSlot.status === 0 &&
      fs.readFileSync(path.join(slotHome, NAME, 'slot'), 'utf8') === 'q\n' &&
      showSlot.stdout.startsWith('slot q (from '),
    `${setSlot.all}\n${showSlot.all}`,
  );
  fs.rmSync(slotHome, { recursive: true, force: true });

  const version = cli(['version']);
  check(
    `${NAME} version prints ${VERSION}`,
    version.status === 0 && version.stdout.trim() === `${NAME} ${VERSION}`,
    version.all,
  );

  const init = cli([
    'init',
    '--yes',
    '--target',
    'staging',
    '--web',
    'https://app.staging.example',
    '--api',
    'https://api.staging.example',
  ]);
  // npm init -y makes a CommonJS project, so init writes the TypeScript files as .mts (ES modules in any project)
  const templates = ['credless.config.mts', 'playwright.config.mts', 'personas.yaml', 'e2e/example.spec.mts'];
  const notWritten = templates.filter((f) => !fs.existsSync(path.join(project, f)));
  const config = fs.existsSync(path.join(project, templates[0]))
    ? fs.readFileSync(path.join(project, templates[0]), 'utf8')
    : '';
  check(
    `${NAME} init --yes --target staging writes the templates (.mts in this CommonJS project)`,
    init.status === 0 &&
      notWritten.length === 0 &&
      !fs.existsSync(path.join(project, 'credless.config.ts')) &&
      config.includes('https://app.staging.example'),
    `${init.all}\nmissing: ${notWritten.join(', ')}`,
  );

  const doctor = cli(['doctor', '--offline']);
  const warnings = /doctor: ready \((\d+) warning/.exec(doctor.stdout)?.[1];
  check(
    `${NAME} doctor --offline exits 0 (${warnings ?? '?'} warning(s), no failure)`,
    doctor.status === 0 && !/^\s+FAIL\s/m.test(doctor.stdout),
    doctor.all,
  );

  const planted = JSON.parse(
    fs.readFileSync(path.join(installedKit, 'dist', 'demo', 'fake-secrets.json'), 'utf8'),
  ).signinPassword;
  const reportsRoot = path.join(project, 'credless-demo', 'reports');

  const demo = cli(['demo']);
  const shown = evidenceOf(demo.stdout);
  const summary = shown.summary && fs.existsSync(shown.summary) ? fs.readFileSync(shown.summary, 'utf8') : '';
  check(
    `${NAME} demo: exit 0, SUMMARY.md says PASS, kept under ./credless-demo/reports`,
    demo.status === 0 &&
      /^# Run \S+: PASS$/m.test(summary) &&
      path.resolve(shown.summary ?? '').startsWith(reportsRoot + path.sep),
    demo.all,
    demo.seconds,
  );
  check(
    `${NAME} demo: the contact sheet exists (${shown.sheets.map((s) => path.basename(s)).join(', ') || 'none listed'})`,
    shown.sheets.length > 0 && shown.sheets.every((s) => fs.existsSync(s) && fs.statSync(s).size > 0),
    demo.all,
  );

  const plant = cli(['demo', '--plant-secret']);
  const plantShown = evidenceOf(plant.stdout);
  const plantSummary =
    plantShown.summary && fs.existsSync(plantShown.summary) ? fs.readFileSync(plantShown.summary, 'utf8') : '';
  const echoed = plant.all.includes(planted);
  check(
    `${NAME} demo --plant-secret: exit 0 with the expected line; SUMMARY.md says FAIL and LEAK`,
    plant.status === 0 &&
      plant.stdout.includes(PLANT_OK) &&
      /^# Run \S+: FAIL$/m.test(plantSummary) &&
      /^- LEAK: /m.test(plantSummary),
    // the output is printed only when the planted value is not in it
    echoed ? '(output withheld: it holds the planted value)' : plant.all,
    plant.seconds,
  );
  check(`${NAME} demo --plant-secret: the planted value is in none of its output`, !echoed);

  // the project has no runs of its own yet, so report reads the demo's: the plant run is the latest
  const list = cli(['report', 'list']);
  const latest = cli(['report']);
  check(
    `${NAME} report list shows the demo's two runs; ${NAME} report prints the latest SUMMARY.md`,
    list.status === 0 &&
      list.stdout.trim().split('\n').length === 2 &&
      list.stdout.includes(path.join('credless-demo', 'reports')) &&
      latest.status === 0 &&
      /^# Run \S+: FAIL$/m.test(latest.stdout),
    echoed ? '(output withheld)' : `${list.all}\n${latest.all.slice(0, 2000)}`,
  );

  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`${NAME}-demo-`));
  check('the demo removed its temp project copies and key dirs', leftovers.length === 0, leftovers.join('\n'));

  await suiteInProject(project, installedKit, bin);

  if (args.has('--skip-npx')) {
    console.log('  skip  npx from an empty directory (--skip-npx)');
    return;
  }
  // `npx <path to a .tgz>` runs the path as a command on npm 10; `--package` is how npx installs a local tarball.
  const cache = exec(tool('npm'), ['config', 'get', 'cache'], { cwd: empty, env }).stdout.trim();
  if (cache) {
    npxCache = path.join(cache, '_npx');
    npxBefore = new Set(fs.existsSync(npxCache) ? fs.readdirSync(npxCache) : []);
  }
  const npx = exec(tool('npx'), ['--yes', `--package=${tarball}`, NAME, 'demo'], {
    cwd: empty,
    env: { ...env, npm_config_ignore_scripts: 'true' },
  });
  const npxShown = evidenceOf(npx.stdout);
  const npxSummary =
    npxShown.summary && fs.existsSync(npxShown.summary) ? fs.readFileSync(npxShown.summary, 'utf8') : '';
  check(
    `npx --yes --package=<tgz> ${NAME} demo in an empty directory: PASS`,
    npx.status === 0 &&
      /^# Run \S+: PASS$/m.test(npxSummary) &&
      path.resolve(npxShown.summary ?? '').startsWith(path.join(empty, 'credless-demo', 'reports') + path.sep),
    npx.all,
    npx.seconds,
  );
}

/**
 * A real suite run inside the user's own project, which `npm init -y` made CommonJS: the shipped demo specs and
 * configs are copied in as a user's own tests would sit, the bundled demo server is the backend, and `run` goes
 * through the normal path. A `.ts` config in a CommonJS project is compiled as CommonJS and fails on `import.meta`;
 * this is the check that the `.mts` files `init` writes and the package ships run there.
 */
async function suiteInProject(projectDir, installedKit, bin) {
  const suite = path.join(projectDir, 'suite');
  for (const sub of ['e2e', 'contract']) {
    fs.cpSync(path.join(installedKit, 'demo', sub), path.join(suite, sub), { recursive: true });
  }
  const keyDir = path.join(projectDir, '.demo-key');
  fs.mkdirSync(keyDir, { mode: 0o700 });
  const keyFile = path.join(keyDir, 'runner.key');
  const server = spawn(
    process.execPath,
    [path.join(installedKit, 'dist', 'demo', 'server.js'), '--write-key', keyFile],
    {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  try {
    const ready = await new Promise((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => resolve(null), 30_000);
      server.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const m = /ready web=(\S+) api=(\S+)/.exec(buffer);
        if (m) {
          clearTimeout(timer);
          resolve({ web: m[1], api: m[2] });
        }
      });
      server.once('exit', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!check('the bundled demo server starts from the installed package', Boolean(ready))) return;
    const r = exec(bin, ['run', '--target', 'demo', '--native'], {
      cwd: path.join(suite, 'e2e'),
      env: { ...env, DEMO_WEB: ready.web, DEMO_API: ready.api, CREDLESS_DEMO_KEY_FILE: keyFile },
    });
    const shown = evidenceOf(r.stdout);
    const summary = shown.summary && fs.existsSync(shown.summary) ? fs.readFileSync(shown.summary, 'utf8') : '';
    check(
      `${NAME} run --target demo inside the CommonJS project: PASS, no module-format error`,
      r.status === 0 && /^# Run \S+: PASS$/m.test(summary) && !/import\.meta|Reparsing as ES module/.test(r.all),
      r.all,
      r.seconds,
    );
  } finally {
    server.kill();
  }
}
