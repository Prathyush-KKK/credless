// The reports: SUMMARY.md's verdict (R01, R06), COVERAGE.md, FLAKES.md, the hash check and the contact sheets.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compare, contactSheets, coverage, hashCheck, hostsIn, summary } from '../../src/evidence/report.ts';
import { EXIT } from '../../src/types.ts';
import { base64, cleanup, readText, runFolder, spec, TINY_PNG, writeResults } from './evidence-fixtures.ts';

const made: string[] = [];
afterEach(() => cleanup(made));

describe('verdict', () => {
  it('R01 SUMMARY.md says FAIL when the suite never ran, whatever else is clean', () => {
    const dir = runFolder(made, { results: false });
    const result = summary(dir);
    expect(result.verdict).toBe('fail');
    expect(result.exitCode).toBe(EXIT.FAIL);
    expect(result.scan).toBe('not-run');
    expect(readText(dir, 'SUMMARY.md')).toMatch(/^# Run 20261008T101500Z-rn01: FAIL/);
    expect(readText(dir, 'SUMMARY.md')).toContain('NO RESULTS');
  });

  it('a clean run with one executed test is a PASS, with totals and no failures', () => {
    const dir = runFolder(made);
    const result = summary(dir);
    expect(result.verdict).toBe('pass');
    expect(result.exitCode).toBe(EXIT.PASS);
    expect(result.totals).toEqual({ total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0, expectedFailures: 0 });
    expect(result.failures).toEqual([]);
    expect(readText(dir, 'SUMMARY.md')).toContain('| selftest | 1 | 0 | 0 | 0 | 0 |');
  });

  it('R06 SUMMARY.md lists the hosts outside the run by name: unlisted first, then the ones let through', () => {
    const dir = runFolder(made, { results: false });
    const body = (lines: string[]): string => base64(lines.join('\n'));
    writeResults(
      dir,
      ['chromium-desktop'],
      [
        spec('S01 signs in', [
          {
            name: 'owner-outside',
            contentType: 'text/plain',
            body: body(['GET https://cdn.example.net/a.js?t=1', 'egress proxy: CONNECT telemetry.example.io:443']),
          },
          {
            name: 'owner-third-party',
            contentType: 'text/plain',
            body: body(['GET https://fonts.example.org/s/x.woff2']),
          },
          {
            name: 'owner-dev-hosts',
            contentType: 'text/plain',
            body: body(['GET https://other-dev.example.com/v1/x']),
          },
          {
            name: 'owner-analytics-blocked',
            contentType: 'text/plain',
            body: body(['GET https://www.googletagmanager.com/gtag/js']),
          },
        ]),
        spec(
          'W12-6 outsider',
          [],
          [
            'Error: guard: [a0.member] request to an unlisted host: GET https://cdn.example.net/b.js (add it to hosts.thirdParty with a reason, or fix the app)',
          ],
        ),
      ],
    );
    const result = summary(dir);
    const text = readText(dir, 'SUMMARY.md');
    expect(text).toContain('## Hosts outside the run');
    expect(text).toContain('| cdn.example.net | unlisted | S01, W12-6 |');
    expect(text).toContain('| telemetry.example.io | unlisted | S01 |');
    expect(text).toContain('| other-dev.example.com | dev-hosts | S01 |');
    expect(text).toContain('| fonts.example.org | third-party | S01 |');
    expect(text).toContain('| www.googletagmanager.com | analytics | S01 |');
    expect(text.indexOf('telemetry.example.io'), 'unlisted hosts come before the ones let through').toBeLessThan(
      text.indexOf('fonts.example.org'),
    );
    expect(text.indexOf('other-dev.example.com'), 'dev hosts come before third-party ones').toBeLessThan(
      text.indexOf('fonts.example.org'),
    );
    expect(text, 'host names only: no paths or queries').not.toContain('a.js');
    expect(text).toContain('CREDLESS_GUARD_OUTSIDE=note');
    expect(result.failures).toEqual([{ title: 'W12-6 outsider', project: 'chromium-desktop' }]);
    expect(text).toContain('| W12-6 outsider | chromium-desktop | Error: guard:');
    const quiet = runFolder(made);
    summary(quiet);
    expect(readText(quiet, 'SUMMARY.md'), 'no section when no outside host was seen').not.toContain(
      'Hosts outside the run',
    );
  });

  it('hostsIn reads hosts out of request lines, CONNECT lines and redirects, lower-cased and once each', () => {
    expect(
      hostsIn(
        'GET https://CDN.example.net/a.js -> https://cdn.example.net/b.js; CONNECT api.example:443; ws://sock.example/x',
      ),
    ).toEqual(['cdn.example.net', 'api.example', 'sock.example']);
  });

  it('the triage shot of a failed test is named in the failures table', () => {
    const dir = runFolder(made, { results: false });
    writeResults(
      dir,
      ['chromium-desktop'],
      [spec('W3 invites a member', [], ['Error: expect(received).toBeVisible()'])],
    );
    fs.mkdirSync(path.join(dir, 'shots'));
    fs.writeFileSync(path.join(dir, 'shots', 'W3-invites-a-member--owner-FAILED-chromium-desktop.png'), TINY_PNG);
    const result = summary(dir);
    expect(result.failures[0]?.shot).toBe('shots/W3-invites-a-member--owner-FAILED-chromium-desktop.png');
    expect(readText(dir, 'SUMMARY.md')).toContain('| shots/W3-invites-a-member--owner-FAILED-chromium-desktop.png |');
  });
});

describe('coverage and comparison', () => {
  it('COVERAGE.md has one row per case with the about() source and expectation, a cell per project', () => {
    const dir = runFolder(made, { results: false });
    const about = [
      { type: 'source', description: 'W1, docs/workspaces.md' },
      { type: 'expected', description: 'the owner sees the new workspace' },
    ];
    writeResults(
      dir,
      ['desktop', 'mobile'],
      [
        spec('W1 creates a workspace', [], [], 'desktop', about),
        spec('W1 creates a workspace', [], ['Error: nope'], 'mobile', about),
        spec('W2 skipped one', [], [], 'desktop', [{ type: 'skip', description: 'flag off on this target' }]),
      ],
    );
    const { rows } = coverage(dir);
    expect(rows).toEqual([
      {
        source: 'W1, docs/workspaces.md',
        expected: 'the owner sees the new workspace',
        test: 'W1 creates a workspace',
        outcomes: { desktop: 'passed', mobile: 'failed' },
      },
      { source: 'real.spec.ts', expected: '', test: 'W2 skipped one', outcomes: { desktop: 'passed' } },
    ]);
    const text = readText(dir, 'COVERAGE.md');
    expect(text).toContain('| Case | What it checks | Expected | Source | desktop | mobile | Result |');
    expect(text).toContain(
      '| W1 | creates a workspace | the owner sees the new workspace | W1, docs/workspaces.md | P | F | FAIL |',
    );
    expect(text).toContain('| W2 | skipped one (skipped: flag off on this target) |  | real.spec.ts | P | - | pass |');
  });

  it('FLAKES.md names the tests whose outcome changed between two runs, and the ones only one run had', () => {
    const a = runFolder(made, { results: false });
    const b = runFolder(made, { results: false });
    writeResults(a, ['chromium-desktop'], [spec('W1 stable', []), spec('W2 flaky', []), spec('W3 only here', [])]);
    writeResults(
      b,
      ['desktop'],
      [spec('W1 stable', []), spec('W2 flaky', [], ['Error: boom']), spec('W4 only there', [])],
    );
    const report = compare(a, b, { playwrightCli: null });
    expect(report.compared).toEqual([path.basename(a), path.basename(b)]);
    expect(report.flaky).toEqual(['real.spec.ts > W2 flaky [chromium-desktop]: P -> F']);
    expect(report.onlyFirst).toEqual(['real.spec.ts > W3 only here [chromium-desktop]']);
    expect(report.onlySecond).toEqual(['real.spec.ts > W4 only there [chromium-desktop]']);
    expect(report.problems).toEqual([]);
    const text = readText(a, 'FLAKES.md');
    expect(text).toContain('results.json compared');
    expect(text).toContain('- real.spec.ts > W2 flaky [chromium-desktop]: P -> F');
    expect(text).toContain('## Only in run B');
    expect(fs.existsSync(path.join(b, 'FLAKES.md'))).toBe(false);
    const withFlakes = summary(a, { flakes: report });
    expect(withFlakes.flakes?.flaky).toHaveLength(1);
    expect(readText(a, 'SUMMARY.md')).toContain('## Double run');
  });

  it('a run without results to compare is a problem, not a crash', () => {
    const a = runFolder(made);
    const b = runFolder(made, { results: false });
    const report = compare(a, b, { playwrightCli: null });
    expect(report.onlyFirst).toHaveLength(1);
    expect(report.problems[0]).toMatch(/no results\.json and no blob report/);
  });
});

describe('screenshots', () => {
  it('the hash check groups byte-identical screenshots of different steps', () => {
    const dir = runFolder(made);
    fs.mkdirSync(path.join(dir, 'shots'));
    fs.writeFileSync(path.join(dir, 'shots', 'W1--owner-home-desktop.png'), TINY_PNG);
    fs.writeFileSync(path.join(dir, 'shots', 'W1--owner-list-desktop.png'), TINY_PNG);
    fs.writeFileSync(
      path.join(dir, 'shots', 'W1--owner-other-desktop.png'),
      Buffer.concat([TINY_PNG, Buffer.from([0])]),
    );
    fs.writeFileSync(path.join(dir, 'shots', 'W1--owner-FAILED-desktop.png'), TINY_PNG);
    const { checked, groups } = hashCheck(dir);
    expect(checked).toBe(3);
    expect(groups).toEqual([['W1--owner-home-desktop.png', 'W1--owner-list-desktop.png']]);
  });

  it('contact sheets: one PNG per project with shots, triage shots left out (needs a Chromium)', async () => {
    const dir = runFolder(made, { results: false });
    writeResults(dir, ['desktop', 'mobile'], [spec('W1 home', [], [], 'desktop'), spec('W1 home', [], [], 'mobile')]);
    fs.mkdirSync(path.join(dir, 'shots'));
    fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-home-desktop.png'), TINY_PNG);
    fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-list-desktop.png'), TINY_PNG);
    fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-FAILED-desktop.png'), TINY_PNG);
    const { made: sheets, problems } = await contactSheets(dir);
    if (problems.length) {
      console.log(`contact sheets not rendered here: ${problems.join('; ')}`);
      expect(sheets).toEqual([]);
      return;
    }
    expect(sheets).toEqual(['contact-sheets/contact-sheet-desktop.png (2)']);
    expect(fs.existsSync(path.join(dir, 'contact-sheets', 'contact-sheet-desktop.png'))).toBe(true);
    expect(
      fs.existsSync(path.join(dir, 'contact-sheets', 'contact-sheet-mobile.png')),
      'no sheet for a project without shots',
    ).toBe(false);
    const result = summary(dir);
    expect(result.contactSheets).toEqual(['contact-sheets/contact-sheet-desktop.png']);
  }, 60_000);

  it('contact sheets without any screenshot need no browser', async () => {
    const dir = runFolder(made);
    expect(await contactSheets(dir)).toEqual({ made: [], problems: [] });
  });
});
