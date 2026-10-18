// The scan on its own (the `evidence scan` command) and the post-run quarantine: exit codes, scan.json,
// QUARANTINED.md, and that nothing it writes or returns carries a value.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quarantineDir, scanDir, scanExitCode } from '../../src/evidence/scan.ts';
import { scrubDir } from '../../src/evidence/scrub.ts';
import { EXIT } from '../../src/types.ts';
import { CODE, cleanup, EVIDENCE_KEY, JWT, KEY, oneFile, readText, reportDir } from './evidence-fixtures.ts';

const made: string[] = [];
afterEach(() => {
  cleanup(made);
  vi.restoreAllMocks();
});

describe('scan', () => {
  it('exits 1 on a planted value, 4 on anything secret-shaped, 0 when clean, and 0 after a scrub', () => {
    const planted = oneFile(made, `key ${KEY} here`);
    expect(scanExitCode(scanDir(planted, { values: [KEY] }))).toBe(EXIT.FAIL);
    const shaped = oneFile(made, `token ${JWT}`);
    expect(scanExitCode(scanDir(shaped, { values: [KEY] }))).toBe(EXIT.EVIDENCE_UNSAFE);
    const both = oneFile(made, `key ${KEY} token ${JWT}`);
    expect(scanExitCode(scanDir(both, { values: [KEY] }))).toBe(EXIT.EVIDENCE_UNSAFE);
    const clean = oneFile(made, 'nothing to see');
    expect(scanExitCode(scanDir(clean, { values: [KEY] }))).toBe(EXIT.PASS);
    scrubDir(planted, { values: [KEY] });
    expect(scanExitCode(scanDir(planted, { values: [KEY] }))).toBe(EXIT.PASS);
  });

  it('counts the files it opened and reports files it could not look into, never a value', () => {
    const dir = reportDir(made);
    fs.writeFileSync(path.join(dir, 'broken.zip'), 'not a zip at all');
    const result = scanDir(dir, { values: [KEY], evidenceKey: EVIDENCE_KEY });
    expect(result.scannedFiles).toBeGreaterThanOrEqual(5);
    expect(result.problems).toEqual(['broken.zip: not a readable zip']);
    expect(result.quarantined).toEqual([]);
    expect(result.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('quarantine deletes the file a finding lives in, lists it, scans again and writes scan.json', () => {
    const dir = reportDir(made);
    const scrubbed = scrubDir(dir, { values: [KEY], evidenceKey: EVIDENCE_KEY });
    // Something the scrub could not know about: a JWT written after the scrub (as if by a late reporter).
    fs.writeFileSync(path.join(dir, 'late.log'), `late token ${JWT}`);
    const { scan, unsafe } = quarantineDir(dir, {
      values: [KEY],
      evidenceKey: EVIDENCE_KEY,
      cookieValues: scrubbed.collected,
      scrubbed,
    });
    expect(unsafe).toBe(false);
    expect(scan.quarantined).toEqual(['late.log']);
    expect(scan.leftAfterRemoval).toEqual([]);
    expect(scan.files).toEqual(expect.arrayContaining([{ file: 'late.log', kind: 'jwt', count: 1 }]));
    expect(scan.files.every((f) => f.file === 'late.log')).toBe(true);
    expect(scan.secretValues).toBeGreaterThan(0);
    expect(scan.secretValuesIn).toEqual(
      expect.arrayContaining(['results.json', 'artifacts/t1/trace.zip', 'encodings.txt']),
    );
    expect(fs.existsSync(path.join(dir, 'late.log'))).toBe(false);
    expect(
      fs.existsSync(path.join(dir, '.sensitive-hashes')),
      'the HMAC list is gone before the evidence is kept',
    ).toBe(false);
    const quarantined = readText(dir, 'QUARANTINED.md');
    expect(quarantined).toContain('- late.log (cookie-value, jwt)');
    expect(quarantined).not.toContain(JWT);
    const written = JSON.parse(readText(dir, 'scan.json')) as typeof scan;
    expect(written.quarantined).toEqual(['late.log']);
    expect(JSON.stringify(written)).not.toContain(JWT);
    expect(JSON.stringify(written)).not.toContain(KEY);
  });

  it('a finding that survives the removal makes the folder unsafe', () => {
    const dir = oneFile(made, `token ${JWT}`);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
    const { scan, unsafe } = quarantineDir(dir, { evidenceKey: EVIDENCE_KEY });
    expect(unsafe).toBe(true);
    expect(scan.leftAfterRemoval).toEqual([{ file: 'out.txt', kind: 'jwt', count: 1 }]);
  });

  it('a clean folder needs no quarantine file', () => {
    const dir = oneFile(made, 'all quiet');
    const { scan, unsafe } = quarantineDir(dir, { evidenceKey: EVIDENCE_KEY });
    expect(unsafe).toBe(false);
    expect(scan.findings).toBe(0);
    expect(fs.existsSync(path.join(dir, 'QUARANTINED.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'scan.json'))).toBe(true);
  });
});
