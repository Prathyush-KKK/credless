// After a suite: make the evidence safe to keep, then make it readable. Runs in the run's private staging folder;
// the CLI moves the folder to the shared reports only when this returns 0 or 1 AND wrote its completion marker.
//
// 1. scrub secrets out of traces and reports; 2. scan; anything left is deleted and listed in QUARANTINED.md;
// 3. suite.json, contact sheets, coverage, double-run comparison, SUMMARY.md; 4. the marker `.post-run-done` (the
// exit code). Exit: 0 the run passed and the evidence is clean; 1 the run failed, evidence clean; 4 the evidence is
// not safe to keep (something secret-shaped survived even the removal, or post-run itself failed), so the caller
// deletes it. A secret VALUE found anywhere is scrubbed and the evidence kept, but the run fails: a code path leaks.
// Fails closed: any error here, or a kill before the marker, means the evidence is deleted.
import fs from 'node:fs';
import path from 'node:path';
import { ENV, EVIDENCE, EXIT, type ExitCode, type FlakeReport, type RunMeta } from '../types.ts';
import { MIN_SECRET_LENGTH, revealAll, type SecretLike, type ShapeOptions } from './patterns.ts';
import { compare, contactSheets, coverage, summary } from './report.ts';
import { quarantineDir } from './scan.ts';
import { scrubDir } from './scrub.ts';
import { topFile } from './walk.ts';

export interface PostRunOptions extends ShapeOptions {
  /** Playwright's own exit code, kept in suite.json apart from the verdict; default 0 */
  suiteExit?: number;
  /** the second run of `--twice`: scrubbed and scanned too, then compared into FLAKES.md */
  compareWith?: string;
  /** the NUL-separated file of values to scrub by value (`ENV.SCRUB_VALUES_FILE`); read once and deleted, whatever happens */
  scrubValuesFile?: string;
  /** more values to scrub by value (what the calling process holds in memory) */
  values?: Iterable<SecretLike>;
  /** a Chromium for the contact sheets; default: Playwright's own */
  executablePath?: string;
  /** where progress lines go; default stdout */
  log?: (line: string) => void;
  /** where problems go; default stderr */
  error?: (line: string) => void;
}

/**
 * The values the CLI handed over for the scrub, NUL-separated in a 0600 file in staging: read once, then the file is
 * deleted, also when reading failed. A missing file means no values; any other failure is an error (the values it
 * held could not be scrubbed), so post-run fails closed.
 */
export function readScrubValuesFile(file: string | undefined): string[] {
  if (!file) return [];
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\0')
      .map((v) => v.trim())
      .filter((v) => v.length >= MIN_SECRET_LENGTH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function shapesOf(options: PostRunOptions): ShapeOptions {
  const { cookieNames, headerNames, codeShape, evidenceKey, codes, codeHashes, patterns } = options;
  return { cookieNames, headerNames, codeShape, evidenceKey, codes, codeHashes, patterns };
}

/** Complete run.json with the exit code post-run decided on; a missing or damaged file is left alone. */
function recordExitCode(dir: string, exitCode: ExitCode): void {
  const file = path.join(dir, EVIDENCE.run);
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta;
    if (typeof meta !== 'object' || meta === null) return;
    meta.exitCode = exitCode;
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // run.json is the runner's record; the verdict is in SUMMARY.md and the marker either way
  }
}

async function pipeline(
  dir: string,
  options: PostRunOptions,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<ExitCode> {
  // First, so the handover file is gone whatever happens next.
  const values = [...revealAll(options.values), ...readScrubValuesFile(options.scrubValuesFile)];
  if (!fs.statSync(dir).isDirectory()) throw new Error('the report dir is not a directory');
  const shapes = shapesOf(options);
  const dirs = options.compareWith ? [dir, options.compareWith] : [dir];
  let unsafe = false;
  let leaked = 0;
  for (const d of dirs) {
    const scrubbed = scrubDir(d, { ...shapes, values });
    const warnings = scrubbed.problems.length ? `; ${scrubbed.problems.length} warning(s)` : '';
    log(`scrub ${path.basename(d)}: ${scrubbed.replaced} value(s) redacted${warnings}`);
    for (const p of scrubbed.problems) log(`  warning: ${p}`);
    const hits = scrubbed.secretValues.reduce((n, v) => n + v.count, 0);
    if (hits) {
      leaked += hits;
      const files = [...new Set(scrubbed.secretValues.map((v) => topFile(v.where)))].join(', ');
      error(`LEAK: a secret value was in the evidence ${hits} time(s), now redacted: ${files}`);
    }
    const q = quarantineDir(d, { ...shapes, values, cookieValues: scrubbed.collected, scrubbed });
    for (const p of q.problems) log(`  warning: ${p}`);
    if (q.scan.quarantined.length) {
      log(`quarantine ${path.basename(d)}: ${q.scan.quarantined.length} file(s) removed (${EVIDENCE.quarantined})`);
    }
    if (q.unsafe) {
      error(
        `secret scan: ${q.scan.leftAfterRemoval.length} finding(s) remain in ${path.basename(d)} after removal; the evidence will not be kept`,
      );
      unsafe = true;
    }
  }
  if (unsafe) return EXIT.EVIDENCE_UNSAFE;

  const suiteExit = options.suiteExit ?? 0;
  fs.writeFileSync(path.join(dir, EVIDENCE.suite), `${JSON.stringify({ exitCode: suiteExit }, null, 2)}\n`);
  const sheets = await contactSheets(dir, { executablePath: options.executablePath });
  log(sheets.made.length ? `contact sheets: ${sheets.made.join(', ')}` : 'contact sheets: no screenshots');
  for (const p of sheets.problems) log(`  warning: ${p}`);
  log(`coverage: ${coverage(dir).rows.length} case(s)`);
  let flakes: FlakeReport | undefined;
  if (options.compareWith) {
    const compared = compare(dir, options.compareWith);
    for (const p of compared.problems) log(`  warning: ${p}`);
    log(`double run: ${compared.flaky.length} test(s) changed outcome`);
    flakes = compared;
  }
  const result = summary(dir, { flakes });
  log(`summary: ${path.join(dir, EVIDENCE.summary)} (${result.verdict.toUpperCase()})`);
  const code = result.verdict === 'pass' && suiteExit === 0 && leaked === 0 ? EXIT.PASS : EXIT.FAIL;
  recordExitCode(dir, code);
  return code;
}

/**
 * The whole pipeline for one run folder; returns the exit code and writes the marker last, only for 0 and 1. Never
 * throws: an error inside is exit 4 with no marker, and its message is not repeated (it could quote the text it
 * choked on).
 */
export async function postRun(dir: string, options: PostRunOptions = {}): Promise<ExitCode> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  let code: ExitCode;
  try {
    code = await pipeline(dir, options, log, error);
  } catch (e) {
    error(`post-run failed (${e instanceof Error ? e.name : 'unknown error'}): the evidence will not be kept`);
    code = EXIT.EVIDENCE_UNSAFE;
  }
  if (code !== EXIT.PASS && code !== EXIT.FAIL) return code;
  // The last act: the CLI keeps the evidence only when this marker exists and matches the exit code.
  try {
    fs.writeFileSync(path.join(dir, EVIDENCE.marker), String(code));
  } catch {
    error('post-run failed: the completion marker could not be written; the evidence will not be kept');
    return EXIT.EVIDENCE_UNSAFE;
  }
  return code;
}

const USAGE = `usage: post-run <report dir> [--suite-exit <code>] [--compare <other report dir>] [--cookie-names a,b] [--header-names a,b] [--code-shape digits6|<regex>]`;

/**
 * The command-line form (`<kit> evidence post-run`, and the runner after the suite): the dir and flags from argv,
 * the values file and the evidence key from the environment, which is cleaned of the file's name at once.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ExitCode> {
  const args = [...argv];
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const list = (name: string): string[] | undefined =>
    option(name)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const dirArg = args[0];
  const suiteExit = Number(option('--suite-exit') ?? 0);
  const compareArg = option('--compare');
  const bad =
    !dirArg ||
    dirArg.startsWith('--') ||
    !fs.existsSync(dirArg) ||
    !Number.isInteger(suiteExit) ||
    (compareArg !== undefined && !fs.existsSync(compareArg));
  const scrubValuesFile = env[ENV.SCRUB_VALUES_FILE];
  // The file's name leaves the environment before anything else runs; the file itself goes when it is read.
  delete env[ENV.SCRUB_VALUES_FILE];
  if (bad || !dirArg) {
    readScrubValuesFile(scrubValuesFile);
    console.error(USAGE);
    return EXIT.USAGE;
  }
  return postRun(path.resolve(dirArg), {
    suiteExit,
    compareWith: compareArg === undefined ? undefined : path.resolve(compareArg),
    scrubValuesFile,
    evidenceKey: env[ENV.EVIDENCE_KEY],
    cookieNames: list('--cookie-names'),
    headerNames: list('--header-names'),
    codeShape: option('--code-shape'),
  });
}
