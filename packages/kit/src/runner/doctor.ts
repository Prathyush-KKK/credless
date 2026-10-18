// `doctor`: is this machine ready to run? One line per check; a warning does not fail. It reads no secret: key
// sources are described by presence (`describe()`), never run or read, and the target probe sends no key. A test
// API that answers its health WITHOUT a key is a broken lock, the one finding that must reach the backend before
// any run. `--security` prints the layers in force (plan §6 F11).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_NAME, KIT_NAME } from '../brand.ts';
import { DEFAULTS, ENV, type ExecPreset, type RunConfig, type RunMode } from '../types.ts';
import { chromiumInstallCommand, missingBrowsers } from './browsers.ts';
import { createKeySource, loadProjectConfig } from './deps.ts';
import { dockerAvailable, dockerOnPath, imageFor, imagePulled, insideContainer, playwrightVersion } from './docker.ts';
import { findConfigFile } from './project.ts';
import { checkSlot, resolveSlot, SlotError } from './slot.ts';
import { isPrivateDir, stagingDirPath } from './staging.ts';

export interface DoctorInput {
  target?: string;
  offline?: boolean;
  security?: boolean;
  slot?: string;
  mode?: RunMode | 'auto';
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** injectable for tests: the probe without a key */
  probe?: (url: string) => Promise<{ status: number; body: string } | null>;
}

export interface DoctorReport {
  lines: string[];
  failed: number;
  warned: number;
}

/**
 * The earliest Node the package declares (`engines`) and runs on: 22.18 strips TypeScript types by default, which the
 * CLI needs to import a project's `<kit>.config.ts` with plain Node.
 */
export const NODE_FLOOR = [22, 18] as const;

/** Names on PATH of the exec presets, for presence checks only. */
export const PRESET_TOOLS: Record<ExecPreset, string> = {
  op: 'op',
  infisical: 'infisical',
  doppler: 'doppler',
  vault: 'vault',
  kubectl: 'kubectl',
};

/** True when a command is on PATH (never run). */
export function onPath(
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, `${tool}${ext}`), fs.constants.X_OK);
        return true;
      } catch {
        // next
      }
    }
  }
  return false;
}

function nodeVersion(): [number, number] {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return [major, minor];
}

function atLeast(
  [major, minor]: readonly [number, number],
  [wantMajor, wantMinor]: readonly [number, number],
): boolean {
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

async function defaultProbe(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    // The body is looked at for two words only and never printed; 64 KiB is plenty for that.
    const body = (await res.text()).slice(0, 65_536);
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** Does the installed Playwright support `trace.secrets` (1.65+)? Version string compare, no import. */
function supportsTraceSecrets(version: string | null): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 65);
}

export async function doctor(input: DoctorInput = {}): Promise<DoctorReport> {
  const env = { ...(input.env ?? process.env) };
  // Nothing below may see these, whatever else is in the environment.
  delete env[ENV.RUNNER_KEY];
  delete env[ENV.SIGNIN_PASSWORD];
  const platform = input.platform ?? process.platform;
  const cwd = input.cwd ?? process.cwd();
  const probe = input.probe ?? defaultProbe;
  const lines: string[] = [];
  let failed = 0;
  let warned = 0;
  const ok = (m: string) => lines.push(`  ok    ${m}`);
  const warn = (m: string) => {
    lines.push(`  warn  ${m}`);
    warned += 1;
  };
  const fail = (m: string) => {
    lines.push(`  FAIL  ${m}`);
    failed += 1;
  };
  const section = (title: string) => lines.push(lines.length ? '' : '', title);

  // --- config (first: the target and the key source come from it; doctor without one still checks the machine)
  let config: RunConfig | null = null;
  let configFile: string | null = null;
  let target = input.target ?? null;
  try {
    configFile = input.configPath ? path.resolve(cwd, input.configPath) : findConfigFile(cwd);
  } catch {
    configFile = null;
  }
  const projectRoot = configFile ? path.dirname(configFile) : cwd;
  lines.push(`${CLI_NAME} doctor${target ? ` (target ${target})` : ''}`);
  section('Config');
  if (!configFile || !fs.existsSync(configFile)) {
    warn(`no ${KIT_NAME}.config.ts in ${cwd} or above it (run \`${CLI_NAME} init\`); target checks skipped`);
  } else {
    try {
      // Without --target: the first local target (the demo, the self-tests), else the first one declared.
      if (!target) {
        const mod = (await import(pathToFileURL(configFile).href)) as {
          default?: { targets?: Record<string, { kind?: string }> };
        };
        const targets = Object.entries(mod.default?.targets ?? {});
        target = (targets.find(([, t]) => t.kind === 'local') ?? targets[0])?.[0] ?? null;
      }
      if (!target) throw new Error('the config declares no targets');
      config = await loadProjectConfig({
        configPath: configFile,
        cwd,
        env: { ...env, [ENV.TARGET]: target, [ENV.SLOT]: DEFAULTS.slot },
      });
      ok(
        `${path.relative(cwd, configFile) || configFile}: target ${target} (${config.endpoints.kind}) web ${config.endpoints.web} api ${config.endpoints.api}`,
      );
    } catch (error) {
      fail(`config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const local = config ? config.endpoints.kind === 'local' : true;
  const remote = config !== null && !local;

  // --- tools
  section('Tools');
  const node = nodeVersion();
  if (atLeast(node, NODE_FLOOR)) ok(`node ${process.versions.node}`);
  else
    fail(`node ${process.versions.node}: ${NODE_FLOOR.join('.')} or later is needed (it strips types from .ts files)`);
  if (onPath('git', env, platform)) ok('git');
  else warn('git is missing (run.json then carries no commit)');

  // --- where runs execute
  let mode: RunMode;
  if (input.mode && input.mode !== 'auto') mode = input.mode;
  else mode = (await dockerAvailable(env)) ? 'docker' : 'native';
  section(`Where runs execute (${mode})`);
  const pwVersion = playwrightVersion(projectRoot);
  if (mode === 'docker') {
    if (await dockerAvailable(env)) ok('docker is running');
    else fail('docker is installed but not running (start Docker, or use --native)');
    const image = imageFor(pwVersion, config?.kit.docker?.image);
    if (!pwVersion) fail(`@playwright/test is not installed in ${projectRoot}: the image tag follows its version`);
    else if (image.pinned) ok(`image ${image.tag} (pinned by digest)`);
    else
      warn(`image ${image.tag} is unpinned: no digest in the runner's table for Playwright ${pwVersion} (plan §6 T11)`);
    if (pwVersion && (await dockerAvailable(env))) {
      if (await imagePulled(image.ref)) ok('image pulled');
      else warn('image not pulled yet: the first run pulls it (about 2 GB)');
    }
  } else {
    if (!insideContainer() && dockerOnPath(env) && !(await dockerAvailable(env))) {
      warn('docker is installed but not running: runs go native (start Docker to run in the Playwright image)');
    }
    if (!pwVersion) fail(`@playwright/test is not installed in ${projectRoot} (npm i -D @playwright/test)`);
    else {
      ok(`@playwright/test ${pwVersion}`);
      const missing = await missingBrowsers(projectRoot, ['chromium', 'firefox', 'webkit']);
      if (missing === null) warn('browsers: could not be checked (@playwright/test did not load)');
      else if (missing.length === 0) ok('browsers: chromium, firefox and webkit');
      else if (!missing.includes('chromium'))
        ok(
          `browsers: chromium (${missing.join(' and ')} not installed; npx playwright install ${missing.join(' ')} when a project needs them)`,
        );
      else
        fail(`browsers missing: ${missing.join(' ')} (${chromiumInstallCommand(pwVersion)}; on Linux add --with-deps)`);
    }
  }

  // --- slot
  section('Slot');
  const resolution = resolveSlot({ flag: input.slot, env, platform });
  try {
    const { slot, source } = checkSlot(resolution, { target: target ?? 'the target', local });
    if (source === 'default') ok(`none set (local targets use ${DEFAULTS.slot})`);
    else {
      ok(`slot ${slot} (from ${resolution.sourceLabel})`);
      if (slot === 'z' && !env.CI) warn('slot z is the one CI uses by convention; use your own letter');
    }
  } catch (error) {
    if (!(error instanceof SlotError)) throw error;
    // Not chosen yet is a setup step, not a fault (`init` cannot pick a machine's letter): a warning, while `run`
    // refuses with the same words until one is set. A letter that is set but malformed fails.
    if (resolution.slot === null) warn(`${error.message} (\`run\` refuses until then)`);
    else fail(error.message);
  }

  // --- evidence
  section('Evidence');
  const staging = stagingDirPath({
    env,
    platform,
    override: env[ENV.STAGING_DIR] ?? config?.kit.evidence?.stagingDir,
    cwd: projectRoot,
  });
  if (fs.existsSync(staging)) {
    if (platform === 'win32')
      ok(`staging folder ${staging} (mode bits are advisory on Windows: keep the profile private)`);
    else if (isPrivateDir(staging, platform)) ok(`staging folder ${staging} (private)`);
    else fail(`staging folder ${staging} is not private; it must be mode 0700 (chmod 700)`);
  } else ok(`staging folder ${staging} (made private on the first run)`);
  if (config)
    ok(`reports go to ${path.resolve(projectRoot, config.kit.evidence?.reportsDir ?? DEFAULTS.reportsDir)}/<run id>`);

  // --- key source (presence only)
  if (config) {
    section('Key source (presence only: nothing is run, nothing is read)');
    const ref = config.kit.key;
    if (!ref) fail('no key source in the config (`key`): runs against a remote target cannot start');
    else {
      let described: string;
      try {
        described = createKeySource(ref).describe();
      } catch (error) {
        described = `${ref.source}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (ref.source === 'exec') {
        const tool = ref.argv?.[0] ?? (ref.preset ? PRESET_TOOLS[ref.preset] : null);
        if (tool && onPath(tool, env, platform)) ok(`${described}: ${tool} is installed`);
        else if (tool) (remote ? fail : warn)(`${described}: ${tool} is not on PATH`);
        else fail(`${described}: neither argv nor a preset`);
      } else if (ref.source === 'env') {
        const name = ref.name ?? ENV.RUNNER_KEY;
        const present = Boolean((input.env ?? process.env)[name]);
        if (present) ok(`${described}: set in this environment (taken over by \`run\`, never printed)`);
        else (remote && !env.CI ? warn : ok)(`${described}: not set here (CI sets it for the one run step)`);
      } else if (ref.source === 'file') {
        const file = path.resolve(projectRoot, ref.path);
        if (!fs.existsSync(file)) (remote ? fail : warn)(`${described}`);
        else if (platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0)
          fail(`${described}: must be mode 0600`);
        else ok(described);
      } else {
        try {
          createRequire(path.join(projectRoot, 'package.json')).resolve('@napi-rs/keyring');
          ok(described);
        } catch {
          fail(`${described}: @napi-rs/keyring is not installed`);
        }
      }
    }
  }

  // --- the target, without a key
  if (config && remote) {
    section(`The target (${config.endpoints.web}, ${config.endpoints.testApi})`);
    if (input.offline) ok('not probed (--offline)');
    else {
      const web = await probe(`${config.endpoints.web}/`);
      if (!web) fail('web app unreachable: network or VPN');
      else if (web.status >= 200 && web.status < 400) ok(`web app answers (${web.status})`);
      else warn(`web app answers ${web.status}`);
      const basePath = config.kit.testApi?.basePath ?? DEFAULTS.basePath;
      const api = await probe(`${config.endpoints.testApi}${basePath}/health`);
      const leaked = api ? /"(keyId|sinks)"\s*:/.test(api.body) : false;
      if (!api) fail('API unreachable: network or VPN');
      else if (api.status === 401) ok('test API is on and asks for the key (401 without one)');
      else if (api.status === 404)
        warn('test API: no route (404): not deployed on this target yet (contract/BACKEND-BRIEF.md)');
      else if (leaked)
        fail(
          `test API answered its health WITHOUT a key (${api.status}): lock broken; tell the backend before any run`,
        );
      else
        warn(
          `test API: ${api.status} without a key (this backend answers unknown paths with ${api.status}: likely not deployed)`,
        );
    }
  }

  // --- security layers
  if (input.security) {
    section('Security layers');
    const on = (m: string) => lines.push(`  on    ${m}`);
    const off = (m: string) => lines.push(`  off   ${m}`);
    on(
      'broker: the runner key stays in the Playwright main process; workers hold a per-run token (inside the test process tree until v0.2)',
    );
    on('egress proxy per browser context: judged by host before DNS; private ranges refused on remote targets');
    on(`canary: every context must reach ${DEFAULTS.canaryHost} through its own proxy, or its test fails`);
    on('lint gate: check-tests forbids browser launch, contexts, proxy options, network, process and fs in test dirs');
    on('worker shim (advisory): workers dial loopback only; bypassable by code that reaches process.binding');
    on('evidence: scrub by value in four encodings, scan, quarantine, marker; anything unfinished is deleted');
    if (supportsTraceSecrets(pwVersion))
      on(`trace secrets: Playwright ${pwVersion} renders known secrets as <secret> in traces`);
    else off(`trace secrets: needs Playwright 1.65 (installed: ${pwVersion ?? 'none'}); the scrub covers it`);
    off('docker isolate: not available in v0.1 (run --isolate lands in v0.2)');
  }

  lines.push('');
  lines.push(
    failed > 0 ? `doctor: ${failed} check(s) failed, ${warned} warning(s)` : `doctor: ready (${warned} warning(s))`,
  );
  return { lines, failed, warned };
}
