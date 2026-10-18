// The evidence pipeline against real Playwright output (E09) and a real browser (contact sheets). These need no kit
// fixture: the suite under test is a child process, and the file system work sits in test/helpers/evidence-harness.ts.
import { expect, test } from '@playwright/test';
import { compare, contactSheets, playwrightCliPath, scanDir, scrubDir } from '../../src/evidence/index.ts';
import {
  deepContains,
  fileExists,
  readText,
  removeDir,
  runChildSuite,
  STANDIN,
  shotsFolder,
} from '../helpers/evidence-harness.ts';

// The sheet renderer launches its own Chromium inside the worker; the worker's trace recorder would try to collect a
// trace from that browser at test end and fail once it is closed. No test here opens a page, so nothing is lost.
test.use({ trace: 'off' });

test.describe('evidence', () => {
  test('E09 a stand-in secret in a step title and an attachment is gone from inside the HTML report, the blob and the trace; the scan is clean', async () => {
    test.setTimeout(300_000);
    const run = runChildSuite();
    try {
      await test.step('the child suite ran and failed on purpose', () => {
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
        expect(fileExists(run.dir, 'html', 'index.html')).toBe(true);
        expect(fileExists(run.dir, 'results.json')).toBe(true);
        expect(fileExists(run.dir, 'junit.xml')).toBe(true);
        expect(fileExists(run.dir, 'blob', 'report.zip')).toBe(true);
      });
      await test.step('the plant reached every report, the embedded zip included', () => {
        const before = deepContains(run.dir, STANDIN);
        expect(before.length).toBeGreaterThan(3);
        expect(
          before.some((w) => w.startsWith('html/index.html#embedded.zip!')),
          before.join('\n'),
        ).toBe(true);
        expect(
          before.some((w) => w.startsWith('blob/report.zip!')),
          before.join('\n'),
        ).toBe(true);
        expect(before).toContain('results.json');
        expect(before).toContain('junit.xml');
        if (run.withBrowser)
          expect(
            before.some((w) => /^artifacts\/.*trace\.zip!/.test(w)),
            before.join('\n'),
          ).toBe(true);
      });
      await test.step('the scrub removes it everywhere and the scan is clean', () => {
        const scrubbed = scrubDir(run.dir, { values: [STANDIN] });
        expect(scrubbed.secretValues.length).toBeGreaterThan(3);
        expect(scrubbed.secretValues.some((v) => v.where.startsWith('html/index.html#embedded!'))).toBe(true);
        expect(deepContains(run.dir, STANDIN)).toEqual([]);
        const scan = scanDir(run.dir, { values: [STANDIN], cookieValues: scrubbed.collected });
        expect(scan.files).toEqual([]);
        expect(JSON.stringify(scrubbed)).not.toContain(STANDIN);
      });
      await test.step('the double-run comparison reads the blob through merge-reports', () => {
        const flakes = compare(run.dir, run.dir);
        expect(flakes.flaky).toEqual([]);
        expect(flakes.problems).toEqual([]);
        expect(flakes.onlyFirst).toEqual([]);
        const text = readText(run.dir, 'FLAKES.md');
        expect(text).toContain(playwrightCliPath() ? 'blob reports merged' : 'results.json compared');
        expect(text).toContain('Tests compared: 1 / 1');
      });
    } finally {
      removeDir(run.root);
    }
  });

  test.describe('contact sheets', () => {
    test('render one PNG per project with screenshots, triage shots left out', async () => {
      const dir = shotsFolder();
      try {
        const { made, problems } = await contactSheets(dir);
        test.skip(problems.length > 0, problems.join('; '));
        expect(made.sort()).toEqual([
          'contact-sheets/contact-sheet-desktop.png (1)',
          'contact-sheets/contact-sheet-mobile.png (1)',
        ]);
        expect(fileExists(dir, 'contact-sheets', 'contact-sheet-desktop.png')).toBe(true);
        expect(fileExists(dir, 'contact-sheets', 'contact-sheet-mobile.png')).toBe(true);
      } finally {
        removeDir(dir);
      }
    });
  });
});
