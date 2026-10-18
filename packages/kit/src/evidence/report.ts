// Turns one run's raw output into evidence a person can check in a minute: contact sheets (one PNG per project with
// every screenshot, labelled), a hash check for identical screenshots, COVERAGE.md (one row per case from the
// `about()` annotations), FLAKES.md (a `--twice` run's two halves compared) and SUMMARY.md (what ran, what failed,
// which hosts were reached, where the evidence is).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  type CoverageRow,
  ENV,
  EVIDENCE,
  EXIT,
  type FlakeReport,
  type RunMeta,
  type RunVerdict,
  type Summary,
  type SummaryFailure,
  type SummaryTotals,
  type TestOutcome,
} from '../types.ts';
import { stripAnsi } from './patterns.ts';
import type { ScanFile } from './scan.ts';

// Playwright's JSON report, loosely typed: every field optional, so a partial or hand-written results.json (the
// self-tests build them) renders a summary instead of crashing post-run.
interface JsonAttachment {
  name?: string;
  contentType?: string;
  path?: string;
  body?: string;
}
interface JsonError {
  message?: string;
}
interface JsonResult {
  duration?: number;
  errors?: JsonError[];
  attachments?: JsonAttachment[];
}
interface JsonAnnotation {
  type: string;
  description?: string;
}
interface JsonTest {
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  annotations?: JsonAnnotation[];
  results?: JsonResult[];
}
interface JsonSpec {
  title?: string;
  file?: string;
  tests?: JsonTest[];
}
interface JsonSuite {
  title?: string;
  file?: string;
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}
interface JsonProject {
  name?: string;
  metadata?: Record<string, unknown>;
}
/** The parts of Playwright's `results.json` the reports read. */
export interface JsonReport {
  config?: { projects?: JsonProject[] };
  suites?: JsonSuite[];
  errors?: JsonError[];
  stats?: { startTime?: string; duration?: number };
}

/** One letter per outcome, as the coverage cells show it. */
export type Mark = 'P' | 'F' | 'X' | 'K' | 'S';

/** One test result, flattened out of the report's suite tree. */
export interface TestRow {
  file: string;
  title: string;
  project: string;
  /** expected | unexpected | flaky | skipped */
  status: string;
  expectedStatus: string;
  annotations: JsonAnnotation[];
  duration: number;
  /** the last result's first error lines, colour codes removed */
  errors: string[];
  allErrors: string[];
  /** the guard's lists, attached as `<persona>-<list>` text bodies */
  guardLists: Array<{ kind: string; body: string }>;
  attachments: string[];
}

const GUARD_LIST = /-(outside|third-party|dev-hosts|analytics-blocked)$/;
const MARK_LABEL: Record<Mark, string> = { P: 'passed', F: 'failed', X: 'expected-failure', K: 'flaky', S: 'skipped' };

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** `results.json` of a run folder, or null when there is none (the suite never ran). */
export function readResults(dir: string): JsonReport | null {
  return readJsonOr<JsonReport | null>(path.join(dir, EVIDENCE.results), null);
}

export function projectsOf(report: JsonReport | null): string[] {
  return (report?.config?.projects ?? []).map((p) => p.name ?? '').filter(Boolean);
}

/** Every test: file, title, project, status, expected status, annotations, first error lines, guard lists. */
export function testsOf(report: JsonReport | null): TestRow[] {
  const out: TestRow[] = [];
  const walk = (suite: JsonSuite, file: string | undefined): void => {
    for (const child of suite.suites ?? []) walk(child, child.file ?? file);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        const attachments = last?.attachments ?? [];
        const allErrors = (last?.errors ?? []).map((e) => stripAnsi(e.message ?? ''));
        out.push({
          file: spec.file ?? file ?? '',
          title: spec.title ?? '',
          project: t.projectName ?? '',
          status: t.status ?? '',
          expectedStatus: t.expectedStatus ?? '',
          annotations: t.annotations ?? [],
          duration: last?.duration ?? 0,
          errors: allErrors
            .flatMap((m) => m.split('\n'))
            .filter((l) => l.trim())
            .slice(0, 6),
          allErrors,
          attachments: attachments.map((a) => a.path ?? '').filter(Boolean),
          guardLists: attachments
            .filter((a) => a.body && GUARD_LIST.test(a.name ?? ''))
            .map((a) => ({
              kind: GUARD_LIST.exec(a.name ?? '')?.[1] ?? '',
              body: Buffer.from(a.body ?? '', 'base64').toString('utf8'),
            })),
        });
      }
    }
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file);
  return out;
}

export function markOf(t: Pick<TestRow, 'status' | 'expectedStatus'>): Mark {
  if (t.status === 'skipped') return 'S';
  if (t.status === 'expected') return t.expectedStatus === 'failed' ? 'X' : 'P';
  return t.status === 'flaky' ? 'K' : 'F';
}

export function outcomeOf(t: Pick<TestRow, 'status' | 'expectedStatus'>): TestOutcome {
  return MARK_LABEL[markOf(t)] as TestOutcome;
}

function shotsOf(dir: string): string[] {
  const shotDir = path.join(dir, EVIDENCE.shots);
  return fs.existsSync(shotDir)
    ? fs
        .readdirSync(shotDir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => path.join(shotDir, f))
    : [];
}

function sheetsOf(dir: string): string[] {
  const sheetDir = path.join(dir, EVIDENCE.contactSheets);
  return fs.existsSync(sheetDir) ? fs.readdirSync(sheetDir).filter((f) => f.endsWith('.png')) : [];
}

/** The case id of a test title: its first word (`W1`, `S01`); the rest is what the test checks. */
function splitTitle(title: string): [string, string] {
  const [id = '', ...rest] = title.split(' ');
  return [id, rest.join(' ')];
}

function slugOf(text: string, max: number): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, max);
}

export interface ContactSheetOptions {
  /** a Chromium to render with; default: Playwright's own, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when set */
  executablePath?: string;
}

/** Desktop layouts get wide cells; a project's `metadata.size` says, or its name does. */
function isDesktop(project: JsonProject): boolean {
  const size = project.metadata?.size;
  if (size === 'desktop' || size === 'mobile') return size === 'desktop';
  return !/mobile|phone/i.test(project.name ?? '');
}

/**
 * One PNG per project with every screenshot of the run (triage shots excluded), labelled with case, persona and
 * step. Needs a Chromium; when none can be launched the sheets are skipped and the problem listed, because a
 * missing picture never makes evidence unsafe.
 */
export async function contactSheets(
  dir: string,
  options: ContactSheetOptions = {},
): Promise<{ made: string[]; problems: string[] }> {
  const made: string[] = [];
  const problems: string[] = [];
  const files = shotsOf(dir).filter((f) => !f.includes('-FAILED-'));
  const plan = (readResults(dir)?.config?.projects ?? [])
    .map((project) => ({
      name: project.name ?? '',
      desktop: isDesktop(project),
      files: files.filter((f) => f.endsWith(`-${project.name ?? ''}.png`)).sort(),
    }))
    .filter((p) => p.name && p.files.length > 0);
  if (plan.length === 0) return { made, problems };
  let browser: Awaited<ReturnType<typeof import('@playwright/test')['chromium']['launch']>>;
  try {
    const { chromium } = await import('@playwright/test');
    const executablePath = options.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  } catch {
    problems.push('contact sheets skipped: no Chromium could be launched');
    return { made, problems };
  }
  const outDir = path.join(dir, EVIDENCE.contactSheets);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    for (const { name, desktop, files: mine } of plan) {
      const width = desktop ? 256 : 150;
      const columns = desktop ? 6 : 10;
      const suffix = `-${name}.png`;
      const cells = mine
        .map((f) => {
          const label = path.basename(f).slice(0, -suffix.length).replace(/--/g, ' / ').replace(/-/g, ' ').slice(0, 90);
          const src = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
          const caption = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return `<figure><img src="${src}" width="${width}"><figcaption>${caption}</figcaption></figure>`;
        })
        .join('\n');
      const html = `<!doctype html><meta charset="utf-8"><style>
        body { margin: 16px; font: 11px/1.3 -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f4f4; color: #111; }
        h1 { font-size: 16px; margin: 0 0 12px; }
        main { display: grid; grid-template-columns: repeat(${columns}, ${width}px); gap: 12px; }
        figure { margin: 0; } img { display: block; border: 1px solid #ccc; background: #fff; }
        figcaption { margin-top: 3px; word-break: break-word; }
      </style><h1>${name.replace(/</g, '&lt;')}: ${mine.length} screenshots</h1><main>${cells}</main>`;
      const page = await browser.newPage({ viewport: { width: columns * (width + 12) + 32, height: 800 } });
      await page.setContent(html, { waitUntil: 'load' });
      const out = path.join(outDir, `contact-sheet-${slugOf(name, 60)}.png`);
      await page.screenshot({ path: out, fullPage: true });
      await page.close();
      made.push(`${EVIDENCE.contactSheets}/${path.basename(out)} (${mine.length})`);
    }
  } finally {
    await browser.close();
  }
  return { made, problems };
}

/** Screenshots of different steps that are byte-identical: a sign of splash or blank captures. */
export function hashCheck(dir: string): { checked: number; groups: string[][] } {
  const byHash = new Map<string, string[]>();
  const files = shotsOf(dir).filter((f) => !f.includes('-FAILED-'));
  for (const f of files) {
    const h = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    byHash.set(h, [...(byHash.get(h) ?? []), path.basename(f)]);
  }
  return { checked: files.length, groups: [...byHash.values()].filter((g) => g.length > 1) };
}

/** Host names in guard lines: `GET https://host/path`, `CONNECT host:443`, `redirect: ... -> https://host/path`. */
export function hostsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of String(text).matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)|\bCONNECT ([a-z0-9.-]+):\d+/gi)) {
    found.add((m[1] ?? m[2] ?? '').toLowerCase());
  }
  found.delete('');
  return [...found];
}

interface HostRow {
  kinds: Set<string>;
  tests: Set<string>;
}

/**
 * Every host the persona browsers reached or tried outside the run's own: unlisted ones (a test failure, or only
 * listed under `GUARD_OUTSIDE=note`) and the ones let through or blocked by a list. Host names only: paths and
 * queries stay in the per-test attachments. This is the list to settle on a first run against a target.
 */
function hostsOf(all: TestRow[]): Map<string, HostRow> {
  const table = new Map<string, HostRow>();
  const add = (host: string, kind: string, title: string): void => {
    const row = table.get(host) ?? { kinds: new Set<string>(), tests: new Set<string>() };
    row.kinds.add(kind);
    row.tests.add(splitTitle(title)[0]);
    table.set(host, row);
  };
  const kindOf: Record<string, string> = { outside: 'unlisted', 'analytics-blocked': 'analytics' };
  for (const t of all) {
    for (const list of t.guardLists) {
      for (const h of hostsIn(list.body)) add(h, kindOf[list.kind] ?? list.kind, t.title);
    }
    const lines = t.allErrors.flatMap((e) => e.split('\n')).filter((l) => /unlisted host/i.test(l));
    for (const line of lines) for (const h of hostsIn(line)) add(h, 'unlisted', t.title);
  }
  return table;
}

/** COVERAGE.md: one row per case, a cell per project, from the `about(source, expected)` annotations. */
export function coverage(dir: string): { rows: CoverageRow[]; file: string } {
  const report = readResults(dir);
  const projects = projectsOf(report);
  interface Row {
    file: string;
    title: string;
    cells: Record<string, Mark>;
    outcomes: Record<string, TestOutcome>;
    notes: Record<string, string>;
  }
  const rows = new Map<string, Row>();
  for (const t of testsOf(report)) {
    const key = `${t.file}::${t.title}`;
    const row = rows.get(key) ?? { file: t.file, title: t.title, cells: {}, outcomes: {}, notes: {} };
    row.cells[t.project] = markOf(t);
    row.outcomes[t.project] = outcomeOf(t);
    for (const a of t.annotations) if (a.description) row.notes[a.type] = a.description;
    rows.set(key, row);
  }
  const result = (row: Row): string => {
    const all = Object.values(row.cells);
    if (all.includes('F')) return 'FAIL';
    if (all.includes('K')) return 'flaky';
    if (all.length && all.every((m) => m === 'S')) return 'skipped';
    if (all.includes('X')) return 'known failure';
    return 'pass';
  };
  const lines = [
    '# Coverage',
    '',
    'P passed, F failed, X failed as expected (a known bug or finding), K flaky, S skipped (the reason is in the row).',
    '',
    `| Case | What it checks | Expected | Source | ${projects.join(' | ')} | Result |`,
    `|---|---|---|---|${projects.map(() => '---').join('|')}|---|`,
  ];
  const out: CoverageRow[] = [];
  for (const row of rows.values()) {
    const [id, rest] = splitTitle(row.title);
    const why = row.notes.skip
      ? ` (skipped: ${row.notes.skip})`
      : row.notes.fixme
        ? ` (waiting: ${row.notes.fixme})`
        : row.notes.fail
          ? ` (known: ${row.notes.fail})`
          : '';
    const source = row.notes.source ?? row.file.replace(/^(\.\.\/)+/, '');
    const expected = row.notes.expected ?? '';
    out.push({ source, expected, test: row.title, outcomes: row.outcomes });
    lines.push(
      `| ${esc(id)} | ${esc(rest)}${esc(why)} | ${esc(expected)} | ${esc(source)} | ${projects.map((p) => row.cells[p] ?? '-').join(' | ')} | ${result(row)} |`,
    );
  }
  const file = path.join(dir, EVIDENCE.coverage);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { rows: out, file };
}

/** Playwright's CLI script next to the installed `@playwright/test`, or null when it is not installed here. */
export function playwrightCliPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve('@playwright/test/cli');
  } catch {
    return null;
  }
}

/** The few harmless variables a helper child (merge-reports) needs; never the parent's whole environment. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** A blob report turned into a JSON report through `playwright merge-reports`, so sharded runs compare too. */
function reportFromBlob(blobFile: string, cli: string): JsonReport {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-merge-'));
  try {
    const out = path.join(tmp, 'report.json');
    execFileSync(process.execPath, [cli, 'merge-reports', '--reporter', 'json', path.dirname(blobFile)], {
      env: childEnv({ PLAYWRIGHT_JSON_OUTPUT_FILE: out }),
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
    return JSON.parse(fs.readFileSync(out, 'utf8')) as JsonReport;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface CompareOptions {
  /** Playwright's cli.js; default: resolved from the installed `@playwright/test`; null to diff results.json only */
  playwrightCli?: string | null;
}

/**
 * FLAKES.md in `a`: tests whose outcome changed between two runs of the same suite. When both runs left a blob
 * report and Playwright's CLI is at hand, each blob is read through `merge-reports` (the blob is the complete record,
 * also of a sharded run); otherwise results.json is diffed.
 */
export function compare(a: string, b: string, options: CompareOptions = {}): FlakeReport & { problems: string[] } {
  const problems: string[] = [];
  const cli = options.playwrightCli === undefined ? playwrightCliPath() : options.playwrightCli;
  const blobs = [a, b].map((d) => path.join(d, EVIDENCE.blob));
  const useBlobs = cli !== null && blobs.every((f) => fs.existsSync(f));
  const outcomesOf = (dir: string, blob: string): Map<string, Mark> => {
    let report: JsonReport | null = null;
    if (useBlobs && cli) {
      try {
        report = reportFromBlob(blob, cli);
      } catch (error) {
        // The name only: merge-reports' output could quote anything in the report.
        const name = error instanceof Error ? error.name : 'error';
        problems.push(`${path.basename(dir)}: merge-reports failed (${name}); compared results.json instead`);
      }
    }
    report ??= readResults(dir);
    if (!report) problems.push(`${path.basename(dir)}: no results.json and no blob report to compare`);
    return new Map(
      testsOf(report).map((t) => [`${t.file.replace(/^(\.\.\/)+/, '')} > ${t.title} [${t.project}]`, markOf(t)]),
    );
  };
  const oa = outcomesOf(a, blobs[0] ?? '');
  const ob = outcomesOf(b, blobs[1] ?? '');
  const keys = [...new Set([...oa.keys(), ...ob.keys()])].sort();
  const flaky = keys
    .filter((k) => oa.has(k) && ob.has(k) && oa.get(k) !== ob.get(k))
    .map((k) => `${k}: ${oa.get(k)} -> ${ob.get(k)}`);
  const onlyFirst = keys.filter((k) => oa.has(k) && !ob.has(k));
  const onlySecond = keys.filter((k) => !oa.has(k) && ob.has(k));
  const lines = [
    '# Double run',
    '',
    `Run A: ${path.basename(a)}; run B: ${path.basename(b)} (${useBlobs ? 'blob reports merged' : 'results.json compared'}). Tests compared: ${oa.size} / ${ob.size}. Outcome changed: ${flaky.length}; only in A: ${onlyFirst.length}; only in B: ${onlySecond.length}.`,
    '',
    ...(flaky.length ? flaky.map((line) => `- ${line}`) : ['No test changed its outcome.']),
    ...(onlyFirst.length ? ['', '## Only in run A', '', ...onlyFirst.map((k) => `- ${k}`)] : []),
    ...(onlySecond.length ? ['', '## Only in run B', '', ...onlySecond.map((k) => `- ${k}`)] : []),
    ...(problems.length ? ['', '## Problems', '', ...problems.map((p) => `- ${p}`)] : []),
  ];
  fs.writeFileSync(path.join(a, EVIDENCE.flakes), `${lines.join('\n')}\n`);
  return { compared: [path.basename(a), path.basename(b)], flaky, onlyFirst, onlySecond, problems };
}

function triageShot(dir: string, t: TestRow): string | undefined {
  const prefix = `${slugOf(t.title, 80)}--`;
  const suffix = `-${t.project}.png`;
  const shot = shotsOf(dir)
    .map((f) => path.basename(f))
    .find((f) => f.startsWith(prefix) && f.includes('-FAILED-') && f.endsWith(suffix));
  return shot ? `${EVIDENCE.shots}/${shot}` : undefined;
}

export interface SummaryOptions {
  /** the double-run comparison, when post-run made one */
  flakes?: FlakeReport;
}

/**
 * SUMMARY.md and the {@link Summary} it is rendered from. PASS needs proof the suite ran: results with at least one
 * executed test, no run errors, a zero suite exit, a clean scan and no secret value anywhere in the evidence (even a
 * redacted one means something leaks it). A finding that survived the quarantine makes the verdict `unsafe`.
 */
export function summary(dir: string, options: SummaryOptions = {}): Summary {
  const report = readResults(dir);
  const run = readJsonOr<Partial<RunMeta>>(path.join(dir, EVIDENCE.run), {});
  const scan = readJsonOr<Partial<ScanFile> | null>(path.join(dir, EVIDENCE.scan), null);
  const suite = readJsonOr<{ exitCode?: number } | null>(path.join(dir, EVIDENCE.suite), null);
  const all = testsOf(report);
  const projects = projectsOf(report);
  const blank = (): Record<Mark, number> => ({ P: 0, F: 0, X: 0, K: 0, S: 0 });
  const per = new Map<string, Record<Mark, number>>(projects.map((p) => [p, blank()]));
  for (const t of all) {
    const counts = per.get(t.project) ?? blank();
    counts[markOf(t)] += 1;
    per.set(t.project, counts);
  }
  const failed = all.filter((t) => markOf(t) === 'F' || markOf(t) === 'K');
  const hc = hashCheck(dir);
  const sheets = sheetsOf(dir);
  const ran = report !== null && all.length > 0;
  const executed = all.filter((t) => markOf(t) !== 'S').length;
  const leaked = scan?.secretValues ?? 0;
  const left = scan?.leftAfterRemoval?.length ?? 0;
  const runErrors = report?.errors ?? [];
  const unsafe = left > 0;
  const ok =
    ran &&
    executed > 0 &&
    failed.length === 0 &&
    !unsafe &&
    leaked === 0 &&
    runErrors.length === 0 &&
    (suite?.exitCode ?? 0) === 0;
  const verdict: RunVerdict = unsafe ? 'unsafe' : ok ? 'pass' : 'fail';
  const exitCode = unsafe ? EXIT.EVIDENCE_UNSAFE : ok ? EXIT.PASS : EXIT.FAIL;
  const runId = run.runId ?? path.basename(dir);
  const scanLine = scan
    ? `${scan.findings === 0 ? 'clean' : `${scan.findings} finding(s), offending files removed (QUARANTINED.md)`}${left ? `; ${left} remain after removal: NOT SAFE TO KEEP` : ''}`
    : 'not run';
  const suiteLine = !ran
    ? 'NO RESULTS: the suite did not run (see the run log)'
    : executed === 0
      ? `NOTHING RAN: all ${all.length} test(s) were skipped`
      : `${all.length} test result(s), ${executed} ran`;
  const lines: Array<string | null> = [
    `# Run ${runId}: ${verdict.toUpperCase()}`,
    '',
    `- Target: ${run.target ?? '?'} (${run.endpoints?.web ?? '?'}, ${run.endpoints?.api ?? '?'}); slot ${run.slot ?? '?'}`,
    `- Code: ${run.git?.branch ?? '?'} ${String(run.git?.sha ?? '?').slice(0, 10)}${run.git?.dirty ? ' (uncommitted changes)' : ''}; persona catalog ${run.catalog?.status ?? '?'}`,
    run.kit
      ? `- Tools: ${run.kit.name} ${run.kit.version}, Playwright ${run.playwright ?? '?'}, Node ${run.node ?? '?'}`
      : null,
    `- Started ${run.startedAt ?? '?'}, finished ${run.finishedAt ?? '?'}; run cleanup: ${JSON.stringify(run.cleanup ?? 'not run')}`,
    `- Secret scan: ${scanLine}`,
    leaked
      ? `- LEAK: a secret value (the runner key, the sign-in password or another registered secret) was in ${(scan?.secretValuesIn ?? []).join(', ') || 'the evidence'} (${leaked} time(s)); it is redacted in what was kept, but a code path leaks it: fix that first`
      : null,
    `- Suite: ${suiteLine}; exit code ${suite?.exitCode ?? 'unknown'}`,
    '',
    '## Totals',
    '',
    '| Project | Passed | Failed | Known failure | Flaky | Skipped |',
    '|---|---|---|---|---|---|',
    ...[...per.entries()].map(([p, c]) => `| ${esc(p)} | ${c.P} | ${c.F} | ${c.X} | ${c.K} | ${c.S} |`),
    '',
  ];
  if (runErrors.length) {
    lines.push(
      '## Run errors (before or around the tests)',
      '',
      ...runErrors.map((e) => `- ${esc(stripAnsi(e.message ?? '').split('\n')[0])}`),
      '',
    );
  }
  const failures: SummaryFailure[] = failed.map((t) => {
    const shot = triageShot(dir, t);
    return shot ? { title: t.title, project: t.project, shot } : { title: t.title, project: t.project };
  });
  lines.push('## Failures to triage', '');
  if (!failed.length) lines.push('None.', '');
  else {
    lines.push(
      'Triage each as `app bug`, `test bug`, `environment` or `spec question`; no retries to hide flakiness.',
      '',
    );
    lines.push('| Test | Project | First error | Shot | Triage |', '|---|---|---|---|---|');
    failed.forEach((t, i) => {
      const first =
        t.errors.find((l) => /Error|Expected|Received|Timed out|violation|refused/.test(l)) ?? t.errors[0] ?? '';
      lines.push(`| ${esc(t.title)} | ${esc(t.project)} | ${esc(first)} | ${esc(failures[i]?.shot ?? '')} | |`);
    });
    lines.push('');
  }
  const seen = hostsOf(all);
  if (seen.size) {
    const order = (row: HostRow): number => (row.kinds.has('unlisted') ? 0 : row.kinds.has('dev-hosts') ? 1 : 2);
    lines.push(
      '## Hosts outside the run',
      '',
      `Unlisted hosts fail the test (or are only listed, with \`${ENV.GUARD_OUTSIDE}=note\`): add each to \`hosts.thirdParty\` in`,
      'the config with a reason, or report it as an app bug. Third-party and dev hosts were let through; analytics hosts',
      'were blocked.',
      '',
      '| Host | Seen as | Tests |',
      '|---|---|---|',
      ...[...seen.entries()]
        .sort(([ha, ra], [hb, rb]) => order(ra) - order(rb) || ha.localeCompare(hb))
        .map(([host, row]) => {
          const tests = [...row.tests].sort();
          const more = tests.length > 8 ? ` and ${tests.length - 8} more` : '';
          return `| ${esc(host)} | ${[...row.kinds].join(', ')} | ${esc(tests.slice(0, 8).join(', '))}${more} |`;
        }),
      '',
    );
  }
  if (options.flakes) {
    const f = options.flakes;
    lines.push(
      '## Double run',
      '',
      `Compared ${f.compared[0]} with ${f.compared[1]}: ${f.flaky.length} test(s) changed outcome, ${f.onlyFirst.length} only in the first, ${f.onlySecond.length} only in the second. Details: FLAKES.md.`,
      '',
    );
  }
  const exists = (rel: string): boolean => fs.existsSync(path.join(dir, rel));
  const ariaCount = exists(EVIDENCE.aria) ? fs.readdirSync(path.join(dir, EVIDENCE.aria)).length : 0;
  const rawParts = [
    `HTML report: ${EVIDENCE.html}/index.html`,
    `JUnit: ${EVIDENCE.junit}`,
    `raw results: ${EVIDENCE.results}`,
    exists(EVIDENCE.ctrf) ? `CTRF: ${EVIDENCE.ctrf}` : null,
    exists(EVIDENCE.blob) ? `blob: ${EVIDENCE.blob}` : null,
    `traces and error contexts of failures: ${EVIDENCE.artifacts}/ (scrubbed)`,
  ].filter((p) => p !== null);
  lines.push(
    '## Evidence',
    '',
    `- Contact sheets: ${sheets.length ? sheets.map((s) => `${EVIDENCE.contactSheets}/${s}`).join(', ') : 'none'}`,
    `- Screenshots: ${EVIDENCE.shots}/ (${shotsOf(dir).length}); identical screenshots across different steps: ${hc.groups.length}${
      hc.groups.length
        ? ` (check for splash or blank captures: ${hc.groups
            .map((g) => g.join(' = '))
            .slice(0, 5)
            .join('; ')})`
        : ''
    }`,
    ariaCount ? `- Aria snapshots: ${EVIDENCE.aria}/ (${ariaCount})` : null,
    `- Coverage table: ${EVIDENCE.coverage}`,
    `- ${rawParts.join('; ')}`,
    exists(EVIDENCE.flakes) ? `- Double run: ${EVIDENCE.flakes}` : null,
    exists(EVIDENCE.quarantined) ? `- Removed by the secret scan: ${EVIDENCE.quarantined}` : null,
    '',
  );
  fs.writeFileSync(path.join(dir, EVIDENCE.summary), `${lines.filter((l) => l !== null).join('\n')}\n`);
  const totals: SummaryTotals = { total: all.length, passed: 0, failed: 0, flaky: 0, skipped: 0, expectedFailures: 0 };
  for (const c of per.values()) {
    totals.passed += c.P;
    totals.failed += c.F;
    totals.flaky += c.K;
    totals.skipped += c.S;
    totals.expectedFailures += c.X;
  }
  const started = Date.parse(run.startedAt ?? '');
  const finished = Date.parse(run.finishedAt ?? '');
  const durationMs =
    report?.stats?.duration ??
    (Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0);
  const result: Summary = {
    runId,
    target: run.target ?? '',
    verdict,
    exitCode,
    totals,
    failures,
    scan: scan ? (scan.findings === 0 ? 'clean' : 'findings') : 'not-run',
    leaked,
    quarantined: scan?.quarantined?.length ?? 0,
    contactSheets: sheets.map((s) => `${EVIDENCE.contactSheets}/${s}`),
    durationMs: Math.round(durationMs),
  };
  if (options.flakes) result.flakes = options.flakes;
  return result;
}
