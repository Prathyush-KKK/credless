#!/usr/bin/env node
// `pnpm smoke:registry`: the release as users get it from a registry, before it is published. It packs the kit with
// npm (what `pnpm release` publishes: `npm publish` in packages/kit packs the same files), starts a throwaway Verdaccio
// on loopback that serves this `credless` and proxies everything else from npmjs, publishes to it, and installs and
// runs `credless demo` the ways people do:
//   npm i -D, pnpm add -D, yarn add -D (classic, and Yarn 4 with nodeLinker: node-modules), bun add -d, npm i -g,
//   npx credless@<version>, pnpm dlx credless@<version>, bunx credless@<version>;
// and Yarn 4's default Plug'n'Play, where `demo` must refuse with the fix (not supported in 0.x).
//
//   node scripts/smoke-registry.mjs [--no-build] [--only npm,pnpm,...] [--keep]
//
// Needs network (npmjs through Verdaccio's uplink; HTTPS_PROXY is passed on when set) and Chromium for the pinned
// Playwright. Nothing is published to the real registry and this package never comes from it: every tool gets a user
// config naming only the loopback registry, and the package is published as a tarball, never from packages/kit.
// Every cache is a temp dir, removed at the end unless --keep. A tool that is not installed is skipped and said so.
// Exit 1 when a check fails.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { packageManager as tool } from './package-managers.mjs';
import { checklist, exec, KIT, NAME, PLAYWRIGHT, ROOT, userEnv, VERSION, verdictOf } from './smoke-lib.mjs';

const VERDACCIO = 'verdaccio@6.10.6';
const YARN_BERRY = 'yarn@4.18.1';
const PATHS = ['npm', 'pnpm', 'yarn', 'yarn-pnp', 'bun', 'global', 'npx', 'dlx', 'bunx'];

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? new Set((argv[i + 1] ?? '').split(',').filter(Boolean)) : null;
})();
for (const [i, arg] of argv.entries()) {
  if (argv[i - 1] === '--only') continue;
  if (!['--no-build', '--only', '--keep'].includes(arg)) {
    console.error(`smoke-registry: unknown option ${arg} (--no-build, --only ${PATHS.join(',')}, --keep)`);
    process.exit(2);
  }
}
const unknownPaths = [...(only ?? [])].filter((p) => !PATHS.includes(p));
if (unknownPaths.length) {
  console.error(`smoke-registry: no path ${unknownPaths.join(', ')} (${PATHS.join(', ')})`);
  process.exit(2);
}
const wanted = (name) => !only || only.has(name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-registry-`));
const dir = (...parts) => {
  const d = path.join(tmp, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const { check, finish } = checklist('smoke:registry');
let verdaccio = null;

/** A free loopback port: bind 0, read it, let it go. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Whether a command answers `--version`; the tools a machine lacks are skipped, not failed. */
function has(command, env) {
  return exec(command, ['--version'], { cwd: tmp, env, timeout: 60_000 }).status === 0;
}

async function startRegistry(env) {
  const port = await freePort();
  const registry = `http://127.0.0.1:${port}/`;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const config = [
    `storage: ${JSON.stringify(dir('verdaccio', 'storage'))}`,
    'auth:',
    '  htpasswd:',
    `    file: ${JSON.stringify(path.join(tmp, 'verdaccio', 'htpasswd'))}`,
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    '    timeout: 60s',
    'packages:',
    // this package only from here, never proxied: the install gets the tarball under test, even once one is on npm
    `  ${JSON.stringify(NAME)}:`,
    '    access: $all',
    '    publish: $authenticated',
    "  '**':",
    '    access: $all',
    '    proxy: npmjs',
    ...(proxy ? [`https_proxy: ${JSON.stringify(proxy)}`] : []),
    'max_body_size: 200mb',
    'log: { type: stdout, format: pretty, level: warn }',
  ].join('\n');
  const configFile = path.join(tmp, 'verdaccio', 'config.yaml');
  fs.writeFileSync(configFile, `${config}\n`);
  const [cmd, ...pre] = tool('npx');
  verdaccio = spawn(cmd, [...pre, '--yes', VERDACCIO, '--config', configFile, '--listen', `127.0.0.1:${port}`], {
    cwd: tmp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  verdaccio.stdout.on('data', (c) => {
    log += c.toString();
  });
  verdaccio.stderr.on('data', (c) => {
    log += c.toString();
  });
  const up = await waitFor(`${registry}-/ping`, 120);
  return { registry, port, up, log: () => log };
}

/** A throwaway user on the loopback registry, for the publish; its token is written to the temp user config only. */
async function addUser(registry) {
  const name = 'smoke';
  const res = await fetch(`${registry}-/user/org.couchdb.user:${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: crypto.randomBytes(18).toString('base64url'), type: 'user', roles: [] }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok && typeof body.token === 'string' ? body.token : null;
}

/** A blank project for one path: a package.json and an .npmrc naming the loopback registry. */
function project(name, registry, manifest = {}) {
  const p = dir('projects', name);
  fs.writeFileSync(
    path.join(p, 'package.json'),
    `${JSON.stringify({ name: `smoke-${name}`, version: '1.0.0', private: true, ...manifest }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(p, '.npmrc'), `registry=${registry}\n`);
  return p;
}

/** `credless demo` through the path's own runner; a PASS SUMMARY.md kept under ./credless-demo/reports. */
function demoCheck(label, command, args, cwd, env, timeout = 600_000) {
  const r = exec(command, args, { cwd, env, timeout });
  const verdict = verdictOf(r.stdout);
  return check(
    `${label}: credless demo PASS`,
    r.status === 0 && /^# Run \S+: PASS$/.test(verdict) && fs.existsSync(path.join(cwd, `${NAME}-demo`, 'reports')),
    r.all,
    r.seconds,
  );
}

function installCheck(label, command, args, cwd, env) {
  const r = exec(command, args, { cwd, env, timeout: 600_000 });
  return check(`${label}: install`, r.status === 0, r.all, r.seconds);
}

async function run() {
  // the staging dir is made private by the first run; created here it would have the default mode doctor refuses
  const env = userEnv(path.join(tmp, 'staging'));
  // every package manager's cache and global state in the temp dir; the user config names only the loopback registry
  const userconfig = path.join(tmp, 'npmrc');
  Object.assign(env, {
    npm_config_userconfig: userconfig,
    npm_config_cache: dir('cache', 'npm'),
    npm_config_store_dir: dir('cache', 'pnpm-store'),
    npm_config_cache_dir: dir('cache', 'pnpm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    YARN_CACHE_FOLDER: dir('cache', 'yarn'),
    YARN_GLOBAL_FOLDER: dir('cache', 'yarn-berry'),
    YARN_ENABLE_TELEMETRY: '0',
    BUN_INSTALL_CACHE_DIR: dir('cache', 'bun'),
    COREPACK_HOME: dir('cache', 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_STRICT: '0',
  });
  fs.writeFileSync(userconfig, '');

  // 1. what `pnpm release` publishes: npm's packing of packages/kit
  if (!argv.includes('--no-build')) {
    const built = exec(tool('pnpm'), ['--filter', './packages/kit', 'build'], { cwd: ROOT, env: process.env });
    if (!check('build packages/kit (tsdown, then the demo)', built.status === 0, built.all, built.seconds)) return;
  }
  const packDir = dir('pack');
  const packed = exec(tool('npm'), ['pack', '--pack-destination', packDir, '--json'], { cwd: KIT, env });
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!check(`npm pack in packages/kit: ${tgz ?? 'no tarball'}`, packed.status === 0 && Boolean(tgz), packed.all)) {
    return;
  }

  // 2. the registry, a user, the publish
  const reg = await startRegistry(env);
  if (!check(`Verdaccio on ${reg.registry} (${VERDACCIO}, npmjs as the uplink)`, reg.up, reg.log())) return;
  const token = await addUser(reg.registry);
  if (!check('a throwaway user on the loopback registry', Boolean(token))) return;
  fs.writeFileSync(userconfig, `registry=${reg.registry}\n//127.0.0.1:${reg.port}/:_authToken=${token}\n`);
  const published = exec(tool('npm'), ['publish', path.join(packDir, tgz), '--registry', reg.registry], {
    cwd: packDir,
    env,
  });
  const viewed = exec(tool('npm'), ['view', `${NAME}@${VERSION}`, 'version', '--registry', reg.registry], {
    cwd: packDir,
    env,
  });
  if (
    !check(
      `npm publish ${tgz}, then npm view ${NAME}@${VERSION}`,
      published.status === 0 && viewed.stdout.trim() === VERSION,
      `${published.all}\n${viewed.all}`,
    )
  ) {
    return;
  }
  // the token was only for the publish; installs need none
  fs.writeFileSync(userconfig, `registry=${reg.registry}\n`);
  const registry = reg.registry;
  // bunx reads no .npmrc outside a project, and corepack fetches Yarn 4 from repo.yarnpkg.com unless given a registry
  Object.assign(env, { BUN_CONFIG_REGISTRY: registry, COREPACK_NPM_REGISTRY: registry.replace(/\/$/, '') });
  const deps = [`${NAME}@${VERSION}`, `@playwright/test@${PLAYWRIGHT}`];
  // bunx keeps each package in $TMPDIR/bunx-<uid>-<name>@<version>, outside its cache dir: a copy left by an earlier
  // run of this script (the same version, other bytes) fails its integrity check, so bun gets its own TMPDIR
  const bunEnv = { ...env, TMPDIR: dir('bun-tmp') };
  const skip = (label, why) => console.log(`  skip  ${label}: ${why}`);

  // 3. a project's own install, each with its package manager's runner
  if (wanted('npm')) {
    const p = project('npm', registry);
    if (installCheck('npm i -D', tool('npm'), ['install', '-D', ...deps], p, env)) {
      demoCheck('npm i -D', path.join(p, 'node_modules', '.bin', NAME), ['demo'], p, env);
    }
  }
  if (wanted('pnpm')) {
    const pnpm = tool('pnpm');
    const p = project('pnpm', registry);
    if (installCheck('pnpm add -D', pnpm, ['add', '-D', ...deps], p, env)) {
      demoCheck('pnpm add -D', pnpm, ['exec', NAME, 'demo'], p, env);
    }
  }
  if (wanted('yarn')) {
    if (!has('yarn', env)) skip('yarn add -D (classic)', 'yarn is not installed');
    else {
      const p = project('yarn', registry);
      const classic = exec('yarn', ['--version'], { cwd: p, env }).stdout.trim();
      if (!classic.startsWith('1.')) skip('yarn add -D (classic)', `yarn here is ${classic}, not 1.x`);
      else if (installCheck(`yarn ${classic} add -D`, 'yarn', ['add', '-D', ...deps], p, env)) {
        demoCheck(`yarn ${classic} add -D`, 'yarn', [NAME, 'demo'], p, env);
      }
    }
  }
  if (wanted('yarn-pnp') || wanted('yarn')) {
    if (!has('corepack', env)) skip(`${YARN_BERRY} (node_modules, then Plug'n'Play)`, 'corepack is not installed');
    else {
      // Yarn 4 ignores .npmrc: the registry and the http allowance go in .yarnrc.yml
      for (const linker of [...(wanted('yarn') ? ['node-modules'] : []), ...(wanted('yarn-pnp') ? ['pnp'] : [])]) {
        const p = project(`yarn4-${linker}`, registry, { packageManager: YARN_BERRY });
        fs.writeFileSync(
          path.join(p, '.yarnrc.yml'),
          [
            `npmRegistryServer: ${JSON.stringify(registry.replace(/\/$/, ''))}`,
            'unsafeHttpWhitelist: ["127.0.0.1"]',
            `nodeLinker: ${linker}`,
            // Yarn 4 quarantines a version for days after its publish (npmMinimalAgeGate); this one is minutes old
            `npmPreapprovedPackages: [${JSON.stringify(NAME)}]`,
            'enableGlobalCache: false',
            'enableTelemetry: false',
            '',
          ].join('\n'),
        );
        fs.writeFileSync(path.join(p, 'yarn.lock'), '');
        const yarn = ['corepack', 'yarn'];
        const label = `${YARN_BERRY} add -D (nodeLinker: ${linker})`;
        if (!installCheck(label, yarn, ['add', '-D', ...deps], p, env)) continue;
        if (linker === 'node-modules') {
          demoCheck(label, yarn, [NAME, 'demo'], p, env);
          continue;
        }
        // Plug'n'Play is refused, with the fix, before anything starts (runner/messages.ts PNP_MESSAGE)
        const refused = exec(yarn, [NAME, 'demo'], { cwd: p, env });
        check(
          `${label}: credless demo refuses with the nodeLinker fix (exit 2)`,
          refused.status === 2 && /Plug'n'Play is not supported yet: .*nodeLinker: node-modules/.test(refused.stderr),
          refused.all,
          refused.seconds,
        );
      }
    }
  }
  if (wanted('bun')) {
    if (!has('bun', env)) skip('bun add -d', 'bun is not installed');
    else {
      const p = project('bun', registry);
      if (installCheck('bun add -d', 'bun', ['add', '-d', ...deps], p, bunEnv)) {
        demoCheck('bun add -d', 'bun', ['x', NAME, 'demo'], p, bunEnv);
      }
    }
  }

  // 4. without a project: a global install and the one-off runners, from an empty directory
  if (wanted('global')) {
    const prefix = dir('global');
    const genv = { ...env, npm_config_prefix: prefix };
    const cwd = dir('projects', 'global-cwd');
    if (installCheck('npm i -g', tool('npm'), ['install', '-g', `${NAME}@${VERSION}`], cwd, genv)) {
      const bin =
        process.platform === 'win32'
          ? [process.execPath, path.join(prefix, 'node_modules', NAME, 'dist', 'cli.js')]
          : path.join(prefix, 'bin', NAME);
      demoCheck('npm i -g', bin, ['demo'], cwd, genv);
    }
  }
  if (wanted('npx')) {
    const cwd = dir('projects', 'npx-cwd');
    fs.writeFileSync(path.join(cwd, '.npmrc'), `registry=${registry}\n`);
    demoCheck(`npx ${NAME}@${VERSION}`, tool('npx'), ['--yes', `${NAME}@${VERSION}`, 'demo'], cwd, env);
  }
  if (wanted('dlx')) {
    const cwd = dir('projects', 'dlx-cwd');
    fs.writeFileSync(path.join(cwd, '.npmrc'), `registry=${registry}\n`);
    demoCheck(`pnpm dlx ${NAME}@${VERSION}`, tool('pnpm'), ['dlx', `${NAME}@${VERSION}`, 'demo'], cwd, env);
  }
  if (wanted('bunx')) {
    if (!has('bun', env)) skip(`bunx ${NAME}@${VERSION}`, 'bun is not installed');
    else {
      const cwd = dir('projects', 'bunx-cwd');
      fs.writeFileSync(path.join(cwd, '.npmrc'), `registry=${registry}\n`);
      demoCheck(`bunx ${NAME}@${VERSION}`, 'bun', ['x', `${NAME}@${VERSION}`, 'demo'], cwd, bunEnv);
    }
  }
}

console.log(`smoke:registry  ${NAME} ${VERSION}, @playwright/test ${PLAYWRIGHT}, node ${process.version}`);
let code = 1;
try {
  await run();
  code = finish();
} finally {
  verdaccio?.kill();
  if (argv.includes('--keep')) console.log(`  kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
