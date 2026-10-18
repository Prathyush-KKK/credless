// The runner end to end against a throwaway Playwright project (no browser, no key: a local target). R05: a run whose
// post-run fails or is killed leaves no evidence folder, in staging or in reports; a run that completes is moved out
// of staging with the marker. B01/B02 through a real run with the broker are Task 6's, in the selftest project proper.
// biome-ignore lint/style/noRestrictedImports: this self-test drives the CLI as a child process on purpose
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { cli, cliAsync, makeProject, type TempProject, until } from '../unit/helpers/tmp-project.ts';

const made: TempProject[] = [];
test.afterEach(() => {
  for (const p of made.splice(0)) p.cleanup();
});
const project = (options?: Parameters<typeof makeProject>[0]) => {
  const p = makeProject({ playwright: true, ...options });
  made.push(p);
  return p;
};
const runDirsIn = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-[a-z0-9]{4}$/.test(n)) : [];

test.describe('runner', () => {
  test('a completed run is kept with its marker and summary; staging is left empty', () => {
    const p = project();
    const r = cli(p, ['run', '--target', 'selftest', '--native']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/credless \d{8}T\d{6}Z-[a-z0-9]{4}: PASS \(target selftest, slot a\)/);
    const kept = runDirsIn(p.reportsDir);
    expect(kept).toHaveLength(1);
    const dir = path.join(p.reportsDir, kept[0] as string);
    expect(fs.readFileSync(path.join(dir, '.post-run-done'), 'utf8')).toBe('0');
    expect(fs.existsSync(path.join(dir, 'SUMMARY.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'results.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.owner'))).toBe(false);
    expect(runDirsIn(p.stagingDir)).toEqual([]);
    expect(fs.readdirSync(p.stagingDir).filter((n) => n.startsWith('.secret-') || n.startsWith('.lock-'))).toEqual([]);
    expect(r.stdout).toContain(`summary: ${path.join(dir, 'SUMMARY.md')}`);
  });

  test('a failing suite is kept and reported as FAIL with exit 1', () => {
    const p = project({ spec: '  expect(1).toBe(2);' });
    const r = cli(p, ['run', '--target', 'selftest', '--native']);
    expect(r.status, r.all).toBe(1);
    expect(r.stdout).toMatch(/: FAIL \(target selftest, slot a\)/);
    expect(runDirsIn(p.reportsDir)).toHaveLength(1);
    expect(runDirsIn(p.stagingDir)).toEqual([]);
  });

  test('R05 post-run that cannot finish: exit 4, no evidence kept anywhere', () => {
    // The test itself puts a directory where post-run writes scan.json: an internal error inside post-run.
    const p = project({
      spec: "  const fs = await import('node:fs');\n  fs.mkdirSync(process.env.CREDLESS_REPORT_DIR + '/scan.json');\n  expect(1).toBe(1);",
    });
    const r = cli(p, ['run', '--target', 'selftest', '--native']);
    expect(r.status, r.all).toBe(4);
    expect(r.stderr).toMatch(/Post-run did not finish \(exit 4\): the evidence was deleted, not kept/);
    expect(runDirsIn(p.reportsDir)).toEqual([]);
    expect(runDirsIn(p.stagingDir)).toEqual([]);
  });

  test('R05 a run stopped by a signal deletes its staging folder and keeps nothing', async () => {
    const p = project({ spec: '  await new Promise((r) => setTimeout(r, 20_000));' });
    const child = cliAsync(p, ['run', '--target', 'selftest', '--native']);
    let output = '';
    child.stdout?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    expect(
      await until(() => runDirsIn(p.stagingDir).length === 1, 60_000),
      `a run folder appears in staging\n${output}`,
    ).toBe(true);
    const lock = fs.readdirSync(p.stagingDir).find((n) => n.startsWith('.lock-selftest-a'));
    expect(lock).toBeDefined();
    child.kill('SIGTERM');
    const exit = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    expect(exit).toBe(143);
    expect(runDirsIn(p.stagingDir)).toEqual([]);
    expect(fs.existsSync(path.join(p.stagingDir, lock as string))).toBe(false);
    expect(runDirsIn(p.reportsDir)).toEqual([]);
  });

  test('--twice runs the suite twice and keeps both folders', () => {
    const p = project();
    const r = cli(p, ['run', '--target', 'selftest', '--native', '--twice']);
    expect(r.status, r.all).toBe(0);
    expect(runDirsIn(p.reportsDir)).toHaveLength(2);
    expect(runDirsIn(p.stagingDir)).toEqual([]);
  });

  test('the lock keeps a second run off the same target and slot', async () => {
    const p = project({ spec: '  await new Promise((r) => setTimeout(r, 20_000));' });
    const first = cliAsync(p, ['run', '--target', 'selftest', '--native']);
    expect(await until(() => fs.existsSync(path.join(p.stagingDir, '.lock-selftest-a')), 60_000)).toBe(true);
    const second = cli(p, ['run', '--target', 'selftest', '--native']);
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/another run on selftest slot a is in progress/);
    first.kill('SIGTERM');
    await new Promise((resolve) => first.once('exit', resolve));
  });
});
