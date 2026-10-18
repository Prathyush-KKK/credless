// `credless demo --plant-secret` end to end, the acceptance test the README promises. D01: the demo runs with one more
// spec that writes the stand-in sign-in password into the test output on purpose; the scrub redacts and counts it,
// SUMMARY.md says LEAK, the run exits 1, and the command reports exactly that and exits 0. The workspace's demo runs
// from source through the CLI as a child process, in a throwaway working directory with its own HOME, staging and
// reports folder. The package's copy of the same command is checked by `pnpm smoke:pack`.
// biome-ignore lint/style/noRestrictedImports: this self-test drives the CLI as a child process and reads its evidence
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { browsersEnv, cli, KIT_ROOT, makeProject, type TempProject } from '../unit/helpers/tmp-project.ts';

const made: TempProject[] = [];
test.afterEach(() => {
  for (const p of made.splice(0)) p.cleanup();
});

const RUN_ID = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
const PLANT_OK =
  'credless demo --plant-secret: the planted value was found in the evidence and the run failed, as it should';

interface Results {
  suites: Array<{ specs?: Array<{ title: string; tests: Array<{ projectName: string; status: string }> }> }>;
}

test.describe('demo', () => {
  test('D01 demo --plant-secret: the planted stand-in is redacted and counted, SUMMARY.md says LEAK, the command exits 0', () => {
    test.setTimeout(300_000);
    const p = makeProject();
    made.push(p);
    const reports = path.join(p.dir, 'demo-reports');
    const r = cli(p, ['demo', '--plant-secret', '--reports-dir', reports], browsersEnv(), 240_000);
    // The value the spec plants: a boolean check only, so no failure message can carry it.
    const fake = path.join(KIT_ROOT, '..', '..', 'apps', 'demo', 'src', 'fake-secrets.json');
    const planted = (JSON.parse(fs.readFileSync(fake, 'utf8')) as { signinPassword: string }).signinPassword;
    expect(r.all.includes(planted), 'the CLI output never shows the planted value').toBe(false);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain(PLANT_OK);
    expect(r.stdout).toMatch(/credless \d{8}T\d{6}Z-[a-z0-9]{4}: FAIL \(target demo, slot a\)/);

    const kept = fs.readdirSync(reports).filter((n) => RUN_ID.test(n));
    expect(kept).toHaveLength(1);
    const dir = path.join(reports, kept[0] as string);
    expect(fs.readFileSync(path.join(dir, '.post-run-done'), 'utf8')).toBe('1');
    const summary = fs.readFileSync(path.join(dir, 'SUMMARY.md'), 'utf8');
    expect(summary).toMatch(/^# Run \S+: FAIL$/m);
    expect(summary).toMatch(/^- LEAK: /m);
    const scan = JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')) as { secretValues?: number };
    expect(scan.secretValues ?? 0).toBeGreaterThan(0);
    for (const file of ['results.json', 'junit.xml']) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8').includes(planted), `${file} no longer holds it`).toBe(false);
    }

    // The plant ran first as its own project and passed: the run failed on the leak, not on a test.
    const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as Results;
    const tests = results.suites.flatMap((s) =>
      (s.specs ?? []).flatMap((spec) => spec.tests.map((t) => ({ spec, t }))),
    );
    const plant = tests.filter(({ spec }) => spec.title.startsWith('P01 '));
    expect(plant.map(({ t }) => [t.projectName, t.status])).toEqual([['plant-secret', 'expected']]);
    expect(tests.filter(({ t }) => t.status !== 'expected' && t.status !== 'skipped')).toEqual([]);
  });
});
