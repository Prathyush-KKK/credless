// Post-run end to end on synthetic run folders: the verdicts (R02–R05), the leak check, the fail-closed marker, the
// scrub-values handover, the double run and the command-line form.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, postRun, readScrubValuesFile } from '../../src/evidence/post-run.ts';
import { ENV, EXIT } from '../../src/types.ts';
import { cleanup, KEY, PASSWORD, readText, runFolder, spec, tempDir, writeResults } from './evidence-fixtures.ts';

const made: string[] = [];
afterEach(() => {
  cleanup(made);
  vi.restoreAllMocks();
});

/** post-run with its output captured, so the test can assert what it printed. */
async function run(dir: string, options: Parameters<typeof postRun>[1] = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await postRun(dir, { ...options, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
}

const marker = (dir: string): string | null =>
  fs.existsSync(path.join(dir, '.post-run-done')) ? readText(dir, '.post-run-done') : null;

describe('post-run', () => {
  it('R02 passes a clean run, and fails one whose suite exited non-zero', async () => {
    const clean = runFolder(made);
    const { code, out } = await run(clean, { suiteExit: 0 });
    expect(code).toBe(EXIT.PASS);
    expect(readText(clean, 'SUMMARY.md')).toMatch(/: PASS/);
    expect(marker(clean)).toBe('0');
    expect(out).toContain('scrub ');
    expect(out).toContain('summary: ');
    expect(JSON.parse(readText(clean, 'suite.json'))).toEqual({ exitCode: 0 });
    expect(JSON.parse(readText(clean, 'run.json')).exitCode).toBe(0);
    expect(fs.existsSync(path.join(clean, 'COVERAGE.md'))).toBe(true);
    expect(fs.existsSync(path.join(clean, 'scan.json'))).toBe(true);
    const crashed = runFolder(made);
    expect((await run(crashed, { suiteExit: 3 })).code).toBe(EXIT.FAIL);
    expect(readText(crashed, 'SUMMARY.md')).toMatch(/: FAIL/);
    expect(readText(crashed, 'SUMMARY.md')).toContain('exit code 3');
    expect(marker(crashed)).toBe('1');
    expect(JSON.parse(readText(crashed, 'run.json')).exitCode).toBe(1);
  });

  it('R04 a run where every test was skipped is not a PASS', async () => {
    const dir = runFolder(made, { skipped: true });
    expect((await run(dir, { suiteExit: 0 })).code).toBe(EXIT.FAIL);
    expect(readText(dir, 'SUMMARY.md')).toMatch(/: FAIL/);
    expect(readText(dir, 'SUMMARY.md')).toContain('NOTHING RAN');
  });

  it('R05 fails closed: an error inside means exit 4 and no completion marker (the runner deletes)', async () => {
    const dir = runFolder(made);
    fs.mkdirSync(path.join(dir, 'scan.json')); // post-run cannot write its scan result: an internal error
    const { code, out } = await run(dir, { suiteExit: 0 });
    expect(code).toBe(EXIT.EVIDENCE_UNSAFE);
    expect(marker(dir)).toBeNull();
    expect(out).toContain('post-run failed (Error): the evidence will not be kept');
    expect(out, 'the error message is not repeated').not.toContain('EISDIR');
    const clean = runFolder(made);
    expect((await run(clean, { suiteExit: 0 })).code).toBe(EXIT.PASS);
    expect(marker(clean)).toBe('0');
  });

  it('R03 a secret value anywhere in the evidence fails the run (and is redacted in what is kept)', async () => {
    const dir = runFolder(made);
    fs.mkdirSync(path.join(dir, 'html'));
    // What a fill() of the password would leave in the HTML report: the step title carries the value.
    fs.writeFileSync(
      path.join(dir, 'html', 'index.html'),
      `<p>Fill "${PASSWORD}" locator('input[type="password"]')</p>`,
    );
    const valuesFile = path.join(tempDir(made, 'staging-'), '.secret-1234-scrub');
    fs.writeFileSync(valuesFile, `${PASSWORD}\0${KEY}\0short`, { mode: 0o600 });
    const { code, out } = await run(dir, { suiteExit: 0, scrubValuesFile: valuesFile });
    expect(code).toBe(EXIT.FAIL);
    expect(out).toContain('LEAK: a secret value was in the evidence 1 time(s), now redacted: html/index.html');
    expect(out).not.toContain(PASSWORD);
    expect(readText(dir, 'html', 'index.html')).not.toContain(PASSWORD);
    expect(readText(dir, 'html', 'index.html')).toContain('Fill "[redacted]"');
    expect(JSON.parse(readText(dir, 'scan.json')).secretValues).toBe(1);
    expect(readText(dir, 'SUMMARY.md')).toMatch(/: FAIL/);
    expect(readText(dir, 'SUMMARY.md')).toContain('LEAK');
    expect(readText(dir, 'SUMMARY.md')).not.toContain(PASSWORD);
    expect(marker(dir), 'the evidence is kept: scrubbed, and the run failed for it').toBe('1');
    expect(fs.existsSync(valuesFile), 'the handover file is deleted once read').toBe(false);
  });

  it('something secret-shaped that survives the quarantine is exit 4 and no marker', async () => {
    const dir = runFolder(made);
    // A shape the scrub cannot take out: the app pattern matches its own replacement, as a broken pattern would.
    fs.writeFileSync(path.join(dir, 'late.log'), 'marker zzz-secret-zzz');
    const patterns = { token: 'zzz-secret-zzz|\\[redacted-token\\]' };
    const realRm = fs.rmSync;
    // The file cannot be removed (as on a read-only mount): the finding survives.
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).endsWith('late.log')) return;
      realRm(target, options);
    });
    const { code, out } = await run(dir, { suiteExit: 0, patterns });
    expect(code).toBe(EXIT.EVIDENCE_UNSAFE);
    expect(marker(dir)).toBeNull();
    expect(out).toContain('1 finding(s) remain');
    expect(out).not.toContain('zzz-secret-zzz');
    expect(fs.existsSync(path.join(dir, 'QUARANTINED.md'))).toBe(true);
  });

  it('the scrub-values handover: a missing file is no values, an unreadable one fails closed, the file always goes', () => {
    expect(readScrubValuesFile(undefined)).toEqual([]);
    expect(readScrubValuesFile(path.join(tempDir(made), 'absent'))).toEqual([]);
    const dir = tempDir(made);
    const file = path.join(dir, 'values');
    fs.writeFileSync(file, ` ${KEY} \0${PASSWORD}\0tiny\0`);
    expect(readScrubValuesFile(file)).toEqual([KEY, PASSWORD]);
    expect(fs.existsSync(file)).toBe(false);
    fs.mkdirSync(file); // a directory where the file should be: not ENOENT, so an error
    expect(() => readScrubValuesFile(file)).toThrow();
  });

  it('--twice: the second folder is scrubbed and scanned too, FLAKES.md lands in the first, the summary says so', async () => {
    const a = runFolder(made, { results: false });
    const b = runFolder(made, { results: false });
    writeResults(a, ['chromium-desktop'], [spec('W1 stable', []), spec('W2 flaky', [])]);
    writeResults(b, ['chromium-desktop'], [spec('W1 stable', []), spec('W2 flaky', [], ['Error: boom'])]);
    fs.writeFileSync(path.join(b, 'note.txt'), `second run key ${KEY}`);
    const { code, out } = await run(a, { suiteExit: 0, compareWith: b, values: [KEY] });
    expect(code, 'the first run passed; the leak is in the second folder and still fails the run').toBe(EXIT.FAIL);
    expect(out).toContain('double run: 1 test(s) changed outcome');
    expect(readText(b, 'note.txt')).toBe('second run key [redacted]');
    expect(readText(a, 'FLAKES.md')).toContain('W2 flaky [chromium-desktop]: P -> F');
    expect(readText(a, 'SUMMARY.md')).toContain('## Double run');
    expect(marker(a)).toBe('1');
    expect(marker(b), 'only the first folder gets the marker').toBeNull();
  });

  it('main: usage errors are exit 2; the values file name leaves the environment at once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main([], {})).toBe(EXIT.USAGE);
    expect(await main(['/no/such/dir'], {})).toBe(EXIT.USAGE);
    const dir = runFolder(made);
    expect(await main([dir, '--suite-exit', 'x'], {})).toBe(EXIT.USAGE);
    expect(await main([dir, '--compare', '/no/such/dir'], {})).toBe(EXIT.USAGE);
    expect(errors).toHaveBeenCalled();
    const valuesFile = path.join(tempDir(made, 'staging-'), '.secret-1-scrub');
    fs.writeFileSync(valuesFile, KEY);
    const env: NodeJS.ProcessEnv = { [ENV.SCRUB_VALUES_FILE]: valuesFile, [ENV.EVIDENCE_KEY]: 'k' };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main([dir, '--suite-exit', '3', '--cookie-names', 'session_token,other'], env)).toBe(EXIT.FAIL);
    expect(env[ENV.SCRUB_VALUES_FILE]).toBeUndefined();
    expect(fs.existsSync(valuesFile)).toBe(false);
    expect(marker(dir)).toBe('1');
    expect(logs).toHaveBeenCalled();
  });
});
