// `node --test action/` runs these; no framework needed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  commentBody,
  findLatestSummary,
  MARKER,
  MAX_COMMENT_CHARS,
  verdictFromExitCode,
  verdictFromSummary,
} from './summary.mjs';

const sample = `# SUMMARY

Verdict: pass
Run 20261018T101500Z-ab12 against demo

| total | passed | failed | flaky | skipped |
|---|---|---|---|---|
| 12 | 12 | 0 | 0 | 0 |

Scan: clean. Leaked values: 0. Quarantined: 0.
`;

test('the comment starts with the marker and carries the summary', () => {
  const body = commentBody(sample, { exitCode: 0, artifactUrl: 'https://example.invalid/artifact', target: 'demo' });
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.match(body, /### credless: pass \(demo\)/);
  assert.match(body, /\| 12 \| 12 \| 0 \|/);
  assert.match(body, /\[evidence artifact\]\(https:\/\/example\.invalid\/artifact\)/);
  assert.match(body, /exit code 0/);
});

test('a long summary is truncated under the GitHub comment limit', () => {
  const long = `Verdict: fail\n${'x'.repeat(200)}\n`.repeat(1000);
  const body = commentBody(long, { exitCode: 1 });
  assert.ok(body.length < 65_536);
  assert.ok(body.length <= MAX_COMMENT_CHARS + 500);
  assert.match(body, /truncated/);
});

test('no summary kept: unsafe and usage say so without inventing numbers', () => {
  assert.match(commentBody(null, { exitCode: 4 }), /credless: unsafe[\s\S]*deleted/);
  assert.match(commentBody(null, { exitCode: 2 }), /credless: usage[\s\S]*did not start/);
  assert.match(commentBody(null, { exitCode: 7 }), /credless: unknown/);
});

test('verdict mapping', () => {
  assert.equal(verdictFromExitCode(0), 'pass');
  assert.equal(verdictFromExitCode('1'), 'fail');
  assert.equal(verdictFromExitCode(2), 'usage');
  assert.equal(verdictFromExitCode(4), 'unsafe');
  assert.equal(verdictFromExitCode(''), 'unknown');
  assert.equal(verdictFromSummary(sample), 'pass');
  assert.equal(verdictFromSummary('# Run 20261018T101500Z-ab12: FAIL\n\n## Totals'), 'fail');
  assert.equal(verdictFromSummary('# Run 20261018T101500Z-ab12: UNSAFE'), 'unsafe');
  assert.equal(verdictFromSummary('**Verdict:** unsafe'), 'unsafe');
  assert.equal(verdictFromSummary('| Verdict | fail |'), 'fail');
  assert.equal(verdictFromSummary('nothing here'), null);
  // the summary's own line wins over the exit code
  assert.match(commentBody('Verdict: fail', { exitCode: 0 }), /credless: fail/);
});

test('the newest run folder with a SUMMARY.md is picked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credless-summary-'));
  const older = join(dir, '20261018T100000Z-aaaa');
  const newer = join(dir, '20261018T110000Z-bbbb');
  const empty = join(dir, '20261018T120000Z-cccc');
  for (const d of [older, newer, empty]) mkdirSync(d);
  writeFileSync(join(older, 'SUMMARY.md'), 'Verdict: pass');
  writeFileSync(join(newer, 'SUMMARY.md'), 'Verdict: fail');
  const t = Date.now() / 1000;
  utimesSync(older, t - 100, t - 100);
  utimesSync(newer, t - 50, t - 50);
  utimesSync(empty, t, t);
  assert.equal(findLatestSummary(dir), join(newer, 'SUMMARY.md'));
  assert.equal(findLatestSummary(join(dir, 'missing')), null);
});
