// The kit's command line (plan §4.4): a small typed argv parser and the dispatch to the commands. Usage and errors go
// to stderr prefixed `<cli>:`; exit codes are `EXIT`. `main` never throws for a usage error.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { CLI_NAME, KIT_NAME } from '../brand.ts';
import { DEFAULTS, EVIDENCE, EXIT, type ExitCode } from '../types.ts';
import { checkTests, type Engine, formatFinding } from './check-tests.ts';
import { demo } from './demo.ts';
import { compare, DEFAULT_ANSWERS, type InitAnswers, scanDir, scanExitCode, scrubDir, writeTemplates } from './deps.ts';
import { doctor } from './doctor.ts';
import { kitVersion } from './global-setup.ts';
import { health, seed } from './health.ts';
import { findConfigFile } from './project.ts';
import { run } from './run.ts';
import { postRunEntry, suite } from './suite.ts';

// --- argv ------------------------------------------------------------------------------------------------------

export interface ArgSpec {
  booleans?: readonly string[];
  strings?: readonly string[];
  /** short option to long name, for example `{ h: 'help' }` */
  aliases?: Readonly<Record<string, string>>;
  /** collect unknown options as passthrough (the `run` command hands them to Playwright) instead of failing */
  loose?: boolean;
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
  /** everything after `--`; under `loose` also unknown options and positionals, in their original order */
  passthrough: string[];
}

export interface ArgError {
  error: string;
}

/** Parse `--name value`, `--name=value`, `--flag`, `--no-flag`, `-x` aliases and `--`. */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs | ArgError {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const parsed: ParsedArgs = { flags: {}, positionals: [], passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') {
      parsed.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      // Under `loose` the order of options and files matters to Playwright, so both travel in passthrough.
      (spec.loose ? parsed.passthrough : parsed.positionals).push(arg);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      const long = spec.aliases?.[short];
      if (!long) {
        if (spec.loose) {
          parsed.passthrough.push(arg);
          // A short option Playwright takes a value for (`-g pattern`) travels with its value.
          if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('-'))
            parsed.passthrough.push(argv[++i] as string);
          continue;
        }
        return { error: `unknown option: ${arg}` };
      }
      name = long;
    }
    if (booleans.has(name)) {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') return { error: `--${name} takes no value` };
      parsed.flags[name] = inline !== 'false';
      continue;
    }
    if (name.startsWith('no-') && booleans.has(name.slice(3))) {
      parsed.flags[name.slice(3)] = false;
      continue;
    }
    if (strings.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return { error: `--${name} needs a value` };
      parsed.flags[name] = value;
      continue;
    }
    if (spec.loose) {
      parsed.passthrough.push(arg);
      if (inline === undefined && argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('-'))
        parsed.passthrough.push(argv[++i] as string);
      continue;
    }
    return { error: `unknown option: --${name}` };
  }
  return parsed;
}

const isError = (p: ParsedArgs | ArgError): p is ArgError => 'error' in p;

function integer(value: string | boolean | undefined, name: string): number | undefined | ArgError {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return { error: `--${name} must be a number` };
  return Number(value);
}

// --- help -----------------------------------------------------------------------------------------------------

export const USAGE = `${CLI_NAME}: signed-in, multi-user Playwright E2E where the credential never reaches the test code

Usage: ${CLI_NAME} <command> [options]

  init [dir] [--yes]                      write ${KIT_NAME}.config.ts (.mts in a CommonJS project), personas.yaml, an example spec and the agent files
  doctor [--target t] [--offline] [--security] [--slot x] [--docker|--native]
                                          is this machine ready: tools, browsers, slot, staging, key source by presence,
                                          the target probed without a key. Reads no secret. --security lists the layers
  run --target t [--slot x] [--workers n] [--twice] [--docker|--native] [--project p] [--wait m] [-- <playwright args>]
                                          the suite; refuses production and unknown targets
  health --target t                       is the test API on, are its sinks wired (no tests run)
  seed --target t [--slot x] [--workers n] create and reset the persona accounts of the slot's namespaces
  report summary|open|compare <run id...> print SUMMARY.md, open the HTML report, compare two runs
  evidence scrub|scan <dir> [--values-file f]
                                          the evidence pipeline by hand
  check-tests [dir...] [--engine ts|regex] the test-code gate: no browsers, network, process or fs in test dirs
  demo [--headed] [--plant-secret] [--reports-dir d] [--demo-dir d] [--target t]
                                          start the demo app and run the quickstart suite against it; evidence in
                                          ./${KIT_NAME}-demo/reports. --plant-secret writes the demo's stand-in password
                                          into the test output on purpose and passes only when the run fails with a LEAK
  version, help

Common options: --config <file> (default: the nearest ${KIT_NAME}.config.ts above the working directory)
Exit codes: 0 pass, 1 a test failed or a secret value was found in the evidence, 2 usage, 4 the evidence was not safe to keep
`;

// --- main -----------------------------------------------------------------------------------------------------

export interface MainIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const COMMON = ['config'] as const;

/** Where a run's evidence is for a run id or a path, using the project's `evidence.reportsDir` when one is configured. */
async function reportDirFor(idOrPath: string, cwd: string, configPath?: string): Promise<string> {
  if (fs.existsSync(idOrPath) && fs.statSync(idOrPath).isDirectory()) return path.resolve(idOrPath);
  const configFile = configPath ? path.resolve(cwd, configPath) : findConfigFile(cwd);
  let reportsDir: string = DEFAULTS.reportsDir;
  let root = cwd;
  if (configFile) {
    root = path.dirname(configFile);
    try {
      const mod = (await import(`${new URL(`file://${configFile}`).href}`)) as {
        default?: { evidence?: { reportsDir?: string } };
      };
      reportsDir = mod.default?.evidence?.reportsDir ?? reportsDir;
    } catch {
      // the default
    }
  }
  return path.resolve(root, reportsDir, idOrPath);
}

/** Open a file with the desktop's opener; never a shell. */
function openWithDesktop(file: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', file]]
        : ['xdg-open', [file]];
  execFile(cmd, args, { windowsHide: true }, () => {
    // best effort: the path was printed either way
  });
}

const INIT_NEXT = `
Next:
  - if you use Claude Code, merge .claude/${KIT_NAME}-settings.snippet.json into .claude/settings.json (the deny rules
    are a backstop, not a boundary)
  - .github/workflows/e2e.yml uses the action at a release tag; pin a commit SHA if your policy requires it
  - ${CLI_NAME} doctor --offline checks the result
`;

/**
 * The answers `init` writes into the templates: the flags, then a prompt for what is missing when a person is at
 * the terminal, else the defaults (`--yes`, CI, a pipe). Nothing asked here is secret: a target name and two origins.
 */
async function askInitAnswers(given: InitAnswers, yes: boolean): Promise<InitAnswers> {
  const complete = given.target !== undefined && given.web !== undefined && given.api !== undefined;
  if (yes || complete || !process.stdin.isTTY || !process.stdout.isTTY) return given;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (label: string, fallback: string): Promise<string> =>
      (await rl.question(`${label} [${fallback}]: `)).trim() || fallback;
    return {
      target:
        given.target ?? (await ask('target name (dev, staging, local; never production)', DEFAULT_ANSWERS.target)),
      web: given.web ?? (await ask('web app origin', DEFAULT_ANSWERS.web)),
      api: given.api ?? (await ask('API origin', DEFAULT_ANSWERS.api)),
    };
  } finally {
    rl.close();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), io: MainIo = {}): Promise<ExitCode> {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const say = (m: string) => void err.write(`${CLI_NAME}: ${m}\n`);
  const usage = (m?: string): ExitCode => {
    if (m) say(m);
    err.write(USAGE);
    return EXIT.USAGE;
  };
  const [command, ...rest] = argv;
  const common = { cwd, env, stdout: out, stderr: err };

  switch (command) {
    case undefined:
      return usage();
    case 'help':
    case '--help':
    case '-h':
      out.write(USAGE);
      return EXIT.PASS;
    case 'version':
    case '--version':
    case '-v':
      out.write(`${CLI_NAME} ${kitVersion()}\n`);
      return EXIT.PASS;

    case 'init': {
      const p = parseArgs(rest, { booleans: ['yes'], strings: ['target', 'web', 'api'] });
      if (isError(p)) return usage(p.error);
      const given: InitAnswers = {
        target: p.flags.target as string | undefined,
        web: p.flags.web as string | undefined,
        api: p.flags.api as string | undefined,
      };
      try {
        const answers = await askInitAnswers(given, Boolean(p.flags.yes));
        const result = await writeTemplates(path.resolve(cwd, p.positionals[0] ?? '.'), answers);
        for (const file of result.written) out.write(`  wrote ${file}\n`);
        for (const file of result.appended) out.write(`  appended ${file}\n`);
        for (const file of result.skipped) out.write(`  kept ${file} (already there)\n`);
        if (result.moduleType === 'commonjs') {
          out.write(
            '  (TypeScript files are .mts: this package.json is not "type": "module", and .mts runs as an ES module either way)\n',
          );
        }
        out.write(INIT_NEXT);
        return EXIT.PASS;
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.USAGE;
      }
    }

    case 'doctor': {
      const p = parseArgs(rest, {
        booleans: ['offline', 'security', 'docker', 'native'],
        strings: ['target', 'slot', ...COMMON],
      });
      if (isError(p)) return usage(p.error);
      if (p.flags.docker && p.flags.native) return usage('--docker and --native exclude each other');
      const report = await doctor({
        target: p.flags.target as string | undefined,
        offline: Boolean(p.flags.offline),
        security: Boolean(p.flags.security),
        slot: p.flags.slot as string | undefined,
        mode: p.flags.docker ? 'docker' : p.flags.native ? 'native' : 'auto',
        configPath: p.flags.config as string | undefined,
        cwd,
        env,
      });
      out.write(`${report.lines.join('\n')}\n`);
      return report.failed > 0 ? EXIT.USAGE : EXIT.PASS;
    }

    case 'run': {
      const p = parseArgs(rest, {
        booleans: ['twice', 'docker', 'native', 'isolate'],
        strings: ['target', 'slot', 'workers', 'project', 'wait', ...COMMON],
        loose: true,
      });
      if (isError(p)) return usage(p.error);
      if (!p.flags.target) return usage('run needs --target <name>');
      if (p.flags.docker && p.flags.native) return usage('--docker and --native exclude each other');
      const workers = integer(p.flags.workers, 'workers');
      if (workers && typeof workers === 'object') return usage(workers.error);
      const wait = integer(p.flags.wait, 'wait');
      if (wait && typeof wait === 'object') return usage(wait.error);
      return run({
        target: p.flags.target as string,
        slot: p.flags.slot as string | undefined,
        workers,
        twice: Boolean(p.flags.twice),
        mode: p.flags.docker ? 'docker' : p.flags.native ? 'native' : 'auto',
        isolate: Boolean(p.flags.isolate),
        project: p.flags.project as string | undefined,
        waitMinutes: wait,
        playwrightArgs: p.passthrough,
        configPath: p.flags.config as string | undefined,
        ...common,
      });
    }

    case 'health':
    case 'seed': {
      const p = parseArgs(rest, { strings: ['target', 'slot', 'workers', ...COMMON] });
      if (isError(p)) return usage(p.error);
      if (!p.flags.target) return usage(`${command} needs --target <name>`);
      const workers = integer(p.flags.workers, 'workers');
      if (workers && typeof workers === 'object') return usage(workers.error);
      const input = {
        target: p.flags.target as string,
        slot: p.flags.slot as string | undefined,
        workers,
        configPath: p.flags.config as string | undefined,
        ...common,
      };
      return command === 'health' ? health(input) : seed(input);
    }

    case 'report': {
      const p = parseArgs(rest, { strings: [...COMMON] });
      if (isError(p)) return usage(p.error);
      const [sub, ...ids] = p.positionals;
      const configPath = p.flags.config as string | undefined;
      try {
        if (sub === 'summary' && ids[0]) {
          // the SUMMARY.md post-run wrote, as kept; never re-rendered from a folder that is already evidence
          out.write(fs.readFileSync(path.join(await reportDirFor(ids[0], cwd, configPath), EVIDENCE.summary), 'utf8'));
          return EXIT.PASS;
        }
        if (sub === 'open' && ids[0]) {
          const file = path.join(await reportDirFor(ids[0], cwd, configPath), EVIDENCE.html, 'index.html');
          if (!fs.existsSync(file)) {
            say(`no HTML report at ${file}`);
            return EXIT.USAGE;
          }
          out.write(`${file}\n`);
          openWithDesktop(file);
          return EXIT.PASS;
        }
        if (sub === 'compare' && ids[0] && ids[1]) {
          const flakes = compare(
            await reportDirFor(ids[0], cwd, configPath),
            await reportDirFor(ids[1], cwd, configPath),
          );
          out.write(`compared ${flakes.compared[0]} with ${flakes.compared[1]}\n`);
          out.write(`  flaky: ${flakes.flaky.length ? flakes.flaky.join(', ') : 'none'}\n`);
          out.write(`  only in the first: ${flakes.onlyFirst.length ? flakes.onlyFirst.join(', ') : 'none'}\n`);
          out.write(`  only in the second: ${flakes.onlySecond.length ? flakes.onlySecond.join(', ') : 'none'}\n`);
          return flakes.flaky.length ? EXIT.FAIL : EXIT.PASS;
        }
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.USAGE;
      }
      return usage('report takes: summary <run id>, open <run id>, compare <run id> <run id>');
    }

    case 'evidence': {
      const p = parseArgs(rest, { strings: ['values-file'] });
      if (isError(p)) return usage(p.error);
      const [sub, dir] = p.positionals;
      if (!dir || (sub !== 'scrub' && sub !== 'scan'))
        return usage('evidence takes: scrub <dir> [--values-file f], scan <dir>');
      const target = path.resolve(cwd, dir);
      if (!fs.existsSync(target)) return usage(`no such directory: ${target}`);
      try {
        if (sub === 'scrub') {
          // Values to scrub come from a NUL-separated file, never from the command line.
          const valuesFile = p.flags['values-file'] as string | undefined;
          const values = valuesFile
            ? fs.readFileSync(path.resolve(cwd, valuesFile), 'utf8').split('\0').filter(Boolean)
            : [];
          const result = scrubDir(target, { values });
          out.write(
            `scrubbed ${target}: ${result.replaced} replacement(s), ${result.secretValues.length} place(s) held a secret value\n`,
          );
          for (const problem of result.problems) say(problem);
          return result.secretValues.length ? EXIT.FAIL : EXIT.PASS;
        }
        // Read-only: files and kinds, never a value. 1 when only registered values are left, 4 for anything else.
        const result = scanDir(target);
        out.write(`scanned ${result.scannedFiles} file(s): ${result.findings} finding(s)\n`);
        for (const f of result.files) out.write(`  ${f.file}: ${f.kind} x${f.count}\n`);
        for (const problem of result.problems) say(problem);
        return scanExitCode(result);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.EVIDENCE_UNSAFE;
      }
    }

    case 'check-tests': {
      const p = parseArgs(rest, { strings: ['engine'] });
      if (isError(p)) return usage(p.error);
      const engine = (p.flags.engine as Engine | undefined) ?? 'auto';
      if (!['auto', 'ts', 'regex'].includes(engine)) return usage('--engine takes ts or regex');
      const targets = p.positionals.length ? p.positionals : fs.existsSync(path.join(cwd, 'e2e')) ? ['e2e'] : [];
      if (!targets.length) return usage('check-tests needs a test directory (no e2e/ here)');
      for (const t of targets) if (!fs.existsSync(path.resolve(cwd, t))) return usage(`no such path: ${t}`);
      try {
        const result = await checkTests(targets, { engine, cwd });
        for (const f of result.findings) out.write(`${formatFinding(f, cwd)}\n`);
        out.write(
          `check-tests: ${result.files} file(s), ${result.findings.length} finding(s) (${result.engine} engine)\n`,
        );
        return result.findings.length ? EXIT.FAIL : EXIT.PASS;
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.USAGE;
      }
    }

    case 'demo': {
      const p = parseArgs(rest, {
        booleans: ['headed', 'plant-secret'],
        strings: ['demo-dir', 'target', 'reports-dir'],
      });
      if (isError(p)) return usage(p.error);
      return demo({
        headed: Boolean(p.flags.headed),
        plantSecret: Boolean(p.flags['plant-secret']),
        reportsDir: p.flags['reports-dir'] as string | undefined,
        demoDir: p.flags['demo-dir'] as string | undefined,
        target: p.flags.target as string | undefined,
        ...common,
      });
    }

    case 'mcp':
      return usage('mcp lands in v0.2');

    // Hidden: the processes `run` starts (docs in suite.ts).
    case '__suite':
      return (await suite(rest, common)) as ExitCode;
    case '__post-run':
      return (await postRunEntry(rest, common)) as ExitCode;

    default:
      return usage(`unknown command: ${command}`);
  }
}
