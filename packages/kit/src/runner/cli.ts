// The kit's command line (plan §4.4): a small typed argv parser and the dispatch to the commands. Usage and errors go
// to stderr prefixed `<cli>:`; exit codes are `EXIT`. `main` never throws for a usage error.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { CLI_NAME, KIT_NAME, REPO_URL } from '../brand.ts';
import { DEFAULTS, EVIDENCE, EXIT, type ExitCode, PATTERNS } from '../types.ts';
import { checkTests, type Engine, formatFinding } from './check-tests.ts';
import { DEMO_EVIDENCE_DIR, demo } from './demo.ts';
import { compare, DEFAULT_ANSWERS, type InitAnswers, scanDir, scanExitCode, scrubDir, writeTemplates } from './deps.ts';
import { doctor, isPlaceholderOrigin } from './doctor.ts';
import { kitVersion } from './global-setup.ts';
import { health, seed } from './health.ts';
import { findConfigFile } from './project.ts';
import { run } from './run.ts';
import { badSlotMessage, resolveSlot, slotFilePath } from './slot.ts';
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

interface CommandHelp {
  /** the arguments after the command name */
  usage: string;
  /** one line for the command list */
  summary: string;
  /** what `help <command>` adds below the summary */
  detail?: string;
  examples: readonly string[];
}

/** Every public command, in the order the usage lists them. `help <command>` and `<command> --help` print one. */
export const COMMANDS: Readonly<Record<string, CommandHelp>> = {
  demo: {
    usage: 'demo [--headed] [--plant-secret] [--reports-dir d] [--demo-dir d] [--target t]',
    summary: 'run the bundled demo app and its suite of signed-in browsers; nothing to set up',
    detail: `The evidence lands in ./${KIT_NAME}-demo/reports/<run id>/ (SUMMARY.md and a contact sheet per browser).
--plant-secret adds one spec that writes the demo's stand-in password into the test output on purpose; the command
passes only when the run fails with a LEAK, which proves the evidence pipeline catches it.`,
    examples: [`${CLI_NAME} demo`, `${CLI_NAME} demo --plant-secret`, `${CLI_NAME} demo --headed`],
  },
  init: {
    usage: 'init [dir] [--yes] [--target t] [--web url] [--api url]',
    summary: `set up a project: ${KIT_NAME}.config.ts, personas.yaml, an example spec and the agent files`,
    detail: `Existing files are kept, and AGENTS.md gets the snippet appended once. At a terminal and without --yes it asks
for the target name and the two origins. In a CommonJS project (no "type": "module") the TypeScript files are .mts.`,
    examples: [
      `${CLI_NAME} init`,
      `${CLI_NAME} init --yes --target staging --web https://staging.example.com --api https://api.staging.example.com`,
    ],
  },
  doctor: {
    usage: 'doctor [--target t] [--offline] [--security] [--slot x] [--docker|--native]',
    summary: 'is this machine ready: tools, browsers, slot, key source (by presence), the target without a key',
    detail: `Reads no secret and runs no key source. --offline skips the network; --security lists which protection layers
are active on this machine. Exit 2 when a check fails.`,
    examples: [`${CLI_NAME} doctor`, `${CLI_NAME} doctor --target staging`, `${CLI_NAME} doctor --security`],
  },
  slot: {
    usage: 'slot [letter]',
    summary: "show or set this machine's slot, the letter that keeps its test accounts apart",
    detail: `A run against a shared target resets and signs in the accounts of its slot (namespaces <letter>0, <letter>1,
...), so every machine needs its own letter. Without a letter it prints the current one and where it comes from.`,
    examples: [`${CLI_NAME} slot`, `${CLI_NAME} slot e`],
  },
  run: {
    usage:
      'run --target t [--slot x] [--workers n] [--twice] [--project p] [--wait m] [--docker|--native] [-- <playwright args>]',
    summary: 'run the suite against a target; refuses production and unknown targets',
    detail: `Reads the runner key from the config's key source, hands it to the broker, runs Playwright, then scrubs and scans
the evidence before keeping it in reports/<run id>/. --twice runs the suite twice and writes FLAKES.md instead of
retrying. Anything after -- goes to Playwright.`,
    examples: [
      `${CLI_NAME} run --target staging`,
      `${CLI_NAME} run --target staging --twice`,
      `${CLI_NAME} run --target staging -- --grep "removed member"`,
    ],
  },
  health: {
    usage: 'health --target t',
    summary: 'is the test API on, with every mail, push and analytics sink wired (no tests run)',
    examples: [`${CLI_NAME} health --target staging`],
  },
  seed: {
    usage: 'seed --target t [--slot x] [--workers n]',
    summary: "create and reset the persona accounts of this machine's slot ahead of a run",
    examples: [`${CLI_NAME} seed --target staging --workers 4`],
  },
  report: {
    usage: 'report [list | summary [run id] | open [run id] | compare <run id> <run id>]',
    summary: 'list runs, print a SUMMARY.md, open the HTML report, or compare two runs',
    detail: 'summary and open default to the latest run; `report` alone prints the latest summary.',
    examples: [`${CLI_NAME} report`, `${CLI_NAME} report list`, `${CLI_NAME} report open`],
  },
  evidence: {
    usage: 'evidence scrub|scan <dir> [--values-file f]',
    summary: 'the evidence pipeline by hand on a folder (scan prints files and kinds, never a value)',
    examples: [`${CLI_NAME} evidence scan reports/<run id>`],
  },
  'check-tests': {
    usage: 'check-tests [dir...] [--engine ts|regex]',
    summary: 'the test-code gate: no browser launches, network, process or fs access in test dirs',
    examples: [`${CLI_NAME} check-tests`, `${CLI_NAME} check-tests e2e`],
  },
  version: { usage: 'version', summary: 'print the version', examples: [`${CLI_NAME} version`] },
  help: {
    usage: 'help [command]',
    summary: 'the commands, or the options and examples of one',
    examples: [`${CLI_NAME} help run`],
  },
};

const COLUMN = 16;

export const USAGE = `${CLI_NAME}: signed-in, multi-user Playwright E2E where the credential never reaches the test code

Usage: ${CLI_NAME} <command> [options]

Start here:
  ${CLI_NAME} demo         the bundled demo app: signed-in browsers and a contact sheet, nothing to set up
  ${CLI_NAME} init         set up this project (config, personas, an example test, the agent files)
  ${CLI_NAME} doctor       check this machine and the target, without reading any secret

Commands:
${Object.entries(COMMANDS)
  .map(([name, help]) => `  ${name.padEnd(COLUMN - 2)}${help.summary}`)
  .join('\n')}

Run \`${CLI_NAME} help <command>\` (or \`<command> --help\`) for its options and examples.
Common options: --config <file> (default: the nearest ${KIT_NAME}.config.ts or .mts above the working directory)
Exit codes: 0 pass, 1 a test failed or a secret value was found in the evidence, 2 usage, 4 the evidence was not safe to keep
`;

/** `help <command>`: the usage line, what it does, and examples. */
export function commandHelp(name: string): string {
  const help = COMMANDS[name];
  if (!help) throw new Error(`no help for ${name}`);
  return [
    `Usage: ${CLI_NAME} ${help.usage}`,
    '',
    `${help.summary.charAt(0).toUpperCase()}${help.summary.slice(1)}.`,
    ...(help.detail ? ['', help.detail] : []),
    '',
    'Examples:',
    ...help.examples.map((e) => `  ${e}`),
    '',
  ].join('\n');
}

/** The closest command name to a mistyped one, when it is close enough to be a likely typo. */
export function suggestCommand(typed: string): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of Object.keys(COMMANDS)) {
    const d = editDistance(typed.toLowerCase(), name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best !== null && bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
}

/** Edits between two words, a swapped neighbouring pair counting as one (so `rnu` is one edit from `run`). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/** `--help` or `-h` before any `--` (after it, the arguments belong to Playwright). */
function wantsHelp(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).some((a) => a === '--help' || a === '-h');
}

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
  return path.join(await reportsRootFor(cwd, configPath), idOrPath);
}

/** The kept runs under the reports folder, newest first, with the verdict from each SUMMARY.md's first line. */
function listRuns(root: string): Array<{ id: string; dir: string; verdict: string }> {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PATTERNS.runId.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((id) => {
      const dir = path.join(root, id);
      let verdict = '?';
      try {
        verdict =
          /:\s*(\S+)\s*$/.exec(fs.readFileSync(path.join(dir, EVIDENCE.summary), 'utf8').split('\n')[0] ?? '')?.[1] ??
          '?';
      } catch {
        // a folder without SUMMARY.md: listed with ?
      }
      return { id, dir, verdict };
    });
}

/**
 * The reports folder of the project around `cwd`: its config's `evidence.reportsDir`, else the default. While that
 * holds no run and `./credless-demo/reports` does (where `credless demo` from the package keeps its runs), the latter:
 * a first `report` after a first `demo` shows the demo's run.
 */
async function reportsRootFor(cwd: string, configPath?: string): Promise<string> {
  const configFile = configPath ? path.resolve(cwd, configPath) : findConfigFile(cwd);
  let reportsDir: string = DEFAULTS.reportsDir;
  if (configFile) {
    try {
      const mod = (await import(pathToFileURL(configFile).href)) as {
        default?: { evidence?: { reportsDir?: string } };
      };
      reportsDir = mod.default?.evidence?.reportsDir ?? reportsDir;
    } catch {
      // the default
    }
  }
  const root = path.resolve(configFile ? path.dirname(configFile) : cwd, reportsDir);
  const demoRoot = path.resolve(cwd, DEMO_EVIDENCE_DIR);
  return listRuns(root).length === 0 && listRuns(demoRoot).length > 0 ? demoRoot : root;
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

/** What `init` prints after the files: the steps between a fresh config and a first run, in order. */
function initNext(target: string, configured: boolean, configFile: string): string {
  return `
Next:
  1. ${configured ? 'check' : 'set the real'} origins of target ${target} and the production rules in ${configFile}
  2. give your backend the test API (seven routes, five locks): ${REPO_URL}/blob/main/contract/BACKEND-BRIEF.md
  3. \`${CLI_NAME} slot <letter>\` once per machine: its own letter, so two machines never share test accounts
  4. \`${CLI_NAME} doctor --target ${target}\` says what is still missing, without reading any secret
  5. \`${CLI_NAME} run --target ${target}\`
  If you use Claude Code, merge .claude/${KIT_NAME}-settings.snippet.json into .claude/settings.json (a backstop).
  .github/workflows/e2e.yml uses the action at a release tag; pin a commit SHA if your policy requires it.
`;
}

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
  const [command, ...rest] = argv;
  const known = command !== undefined && Object.hasOwn(COMMANDS, command);
  /** One line saying what is wrong, then where the options are: never the whole command list. */
  const usage = (m?: string): ExitCode => {
    if (!m) {
      err.write(USAGE);
      return EXIT.USAGE;
    }
    say(m);
    err.write(
      known && command !== 'help'
        ? `Run \`${CLI_NAME} help ${command}\` for its options and examples.\n`
        : `Run \`${CLI_NAME} help\` for the commands.\n`,
    );
    return EXIT.USAGE;
  };
  const common = { cwd, env, stdout: out, stderr: err };
  if (known && command !== 'help' && wantsHelp(rest)) {
    out.write(commandHelp(command));
    return EXIT.PASS;
  }

  switch (command) {
    case undefined:
      return usage();
    case 'help':
    case '--help':
    case '-h': {
      const topic = command === 'help' ? rest[0] : undefined;
      if (!topic) {
        out.write(USAGE);
        return EXIT.PASS;
      }
      if (Object.hasOwn(COMMANDS, topic)) {
        out.write(commandHelp(topic));
        return EXIT.PASS;
      }
      const near = suggestCommand(topic);
      return usage(`no command "${topic}"${near ? `; did you mean "${near}"?` : ''}`);
    }
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
            '  (TypeScript files are .mts: no package.json here says "type": "module", and .mts runs as an ES module either way)\n',
          );
        }
        out.write(
          initNext(
            answers.target ?? DEFAULT_ANSWERS.target,
            !isPlaceholderOrigin(answers.web ?? DEFAULT_ANSWERS.web),
            `${KIT_NAME}.config.${result.moduleType === 'commonjs' ? 'mts' : 'ts'}`,
          ),
        );
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

    case 'slot': {
      const p = parseArgs(rest, {});
      if (isError(p)) return usage(p.error);
      const file = slotFilePath({ env });
      const letter = p.positionals[0];
      if (p.positionals.length > 1) return usage('slot takes one letter');
      if (!letter) {
        const current = resolveSlot({ env, file });
        if (current.slot !== null && !PATTERNS.slot.test(current.slot)) {
          say(`${badSlotMessage(current)}; \`${CLI_NAME} slot <letter>\` replaces the file`);
          return EXIT.USAGE;
        }
        out.write(
          current.slot
            ? `slot ${current.slot} (from ${current.sourceLabel})\n`
            : `no slot set on this machine; \`${CLI_NAME} slot <letter>\` sets one (it is written to ${file})\n`,
        );
        return EXIT.PASS;
      }
      if (!PATTERNS.slot.test(letter)) return usage(`the slot is one lowercase letter, a to z (got "${letter}")`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${letter}\n`);
      out.write(
        `slot ${letter} written to ${file}: runs from this machine use the accounts of namespaces ${letter}0, ${letter}1, ...\n`,
      );
      return EXIT.PASS;
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
      const [sub = 'summary', ...ids] = p.positionals;
      const configPath = p.flags.config as string | undefined;
      try {
        if (sub === 'list') {
          const root = await reportsRootFor(cwd, configPath);
          const runs = listRuns(root);
          if (!runs.length) {
            out.write(`no runs in ${root} yet\n`);
            return EXIT.PASS;
          }
          for (const r of runs) out.write(`${r.id}  ${r.verdict.padEnd(6)}  ${path.relative(cwd, r.dir) || r.dir}\n`);
          return EXIT.PASS;
        }
        // summary and open take the latest run when none is named
        let id = ids[0];
        if ((sub === 'summary' || sub === 'open') && !id) {
          const root = await reportsRootFor(cwd, configPath);
          id = listRuns(root)[0]?.id;
          if (!id) {
            say(
              `no runs in ${root} yet: \`${CLI_NAME} run --target <t>\` keeps one there, or try \`${CLI_NAME} demo\``,
            );
            return EXIT.USAGE;
          }
        }
        if (sub === 'summary' && id) {
          // the SUMMARY.md post-run wrote, as kept; never re-rendered from a folder that is already evidence
          out.write(fs.readFileSync(path.join(await reportDirFor(id, cwd, configPath), EVIDENCE.summary), 'utf8'));
          return EXIT.PASS;
        }
        if (sub === 'open' && id) {
          const file = path.join(await reportDirFor(id, cwd, configPath), EVIDENCE.html, 'index.html');
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
      return usage('report takes: list, summary [run id], open [run id], compare <run id> <run id>');
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

    default: {
      say(`unknown command: ${command}`);
      const near = suggestCommand(command);
      if (near) say(`did you mean "${near}"? (\`${CLI_NAME} help ${near}\`)`);
      err.write(`Run \`${CLI_NAME} help\` for the commands.\n`);
      return EXIT.USAGE;
    }
  }
}
