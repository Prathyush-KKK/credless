// The evidence scrubber: what a person or an agent may read after a run (ports of the private E01, E02, E06–E08).
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDir } from '../../src/evidence/scan.ts';
import { scrubDir } from '../../src/evidence/scrub.ts';
import {
  base64At,
  CODE,
  CSRF,
  cleanup,
  EVIDENCE_KEY,
  hashOf,
  JWT,
  jsonOnce,
  jsonTwice,
  KEY,
  OTHER_COOKIE,
  OTHER_NUMBER,
  oneFile,
  PASSWORD,
  RUN,
  readText,
  reportDir,
} from './evidence-fixtures.ts';

const made: string[] = [];
afterEach(() => cleanup(made));

const options = { values: [KEY, PASSWORD], evidenceKey: EVIDENCE_KEY };

describe('evidence', () => {
  it('E01 the scan finds what is left, by kind, never by value', () => {
    const dir = reportDir(made);
    const { files, findings } = scanDir(dir, options);
    expect(findings).toBe(files.length);
    const kinds = new Set(files.map((f) => f.kind));
    for (const kind of ['jwt', 'credential-header', 'session-cookie', 'code', 'secret-value', 'cookie-object']) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(files.some((f) => f.file === 'html/index.html#embedded!report.json')).toBe(true);
    expect(
      files.some((f) => f.file === 'artifacts/t1/trace.zip!nested.zip!inner.txt' && f.kind === 'secret-value'),
    ).toBe(true);
    expect(files.some((f) => f.file === 'results.json#body' && f.kind === 'secret-value')).toBe(true);
    const text = JSON.stringify(files);
    for (const value of [JWT, CODE, KEY, CSRF, PASSWORD]) expect(text).not.toContain(value);
  });

  it('E02 scrub, then the scan is clean; traces still open; harmless numbers survive', () => {
    const dir = reportDir(made);
    const scrubbed = scrubDir(dir, options);
    expect(scrubbed.replaced).toBeGreaterThan(5);
    expect(scrubbed.collected.has(CSRF)).toBe(true);
    expect(scrubbed.cookieValues).toBe(scrubbed.collected.size);
    expect(Object.keys(scrubbed), 'the collected values are not an enumerable part of the result').not.toContain(
      'collected',
    );
    expect(JSON.stringify(scrubbed)).not.toContain(CSRF);
    expect(scanDir(dir, { ...options, cookieValues: scrubbed.collected }).files).toEqual([]);

    const entries = unzipSync(fs.readFileSync(path.join(dir, 'artifacts', 't1', 'trace.zip')));
    const network = strFromU8(entries['0-trace.network'] ?? new Uint8Array());
    expect(network, 'cookie names stay, every value goes').toContain(
      '"name":"Cookie","value":"sid=[redacted]; csrf=[redacted]"',
    );
    expect(network).not.toContain(CODE);
    expect(network).toContain(OTHER_NUMBER);
    const trace = strFromU8(entries['0-trace.trace'] ?? new Uint8Array());
    expect(trace).not.toContain(CSRF);
    expect(trace).not.toContain(OTHER_COOKIE);
    expect(trace).not.toContain(JWT);
    const snap = strFromU8(entries['resources/snap.html'] ?? new Uint8Array());
    expect(snap.split('[redacted-code]').length - 1, 'all three forms of the code').toBe(3);
    expect(snap).toContain(OTHER_NUMBER);
    const nested = unzipSync(entries['nested.zip'] ?? new Uint8Array());
    expect(strFromU8(nested['inner.txt'] ?? new Uint8Array()), 'a zip inside the trace zip').toBe(
      'nested key [redacted]',
    );

    const results = readText(dir, 'results.json');
    expect(results).not.toContain(KEY);
    const body = (JSON.parse(results) as { attachments: Array<{ body: string }> }).attachments[0]?.body ?? '';
    expect(Buffer.from(body, 'base64').toString()).toBe('calls with key [redacted]');

    const html = readText(dir, 'html', 'index.html');
    expect(html).toContain('data:application/zip;base64,');
    const embedded = /base64,([A-Za-z0-9+/=]+)/.exec(html)?.[1] ?? '';
    const report = strFromU8(unzipSync(Buffer.from(embedded, 'base64'))['report.json'] ?? new Uint8Array());
    expect(report, 'inside the embedded zip').not.toContain(JWT);
    expect(report).toContain('token [redacted');
  });

  it('every encoding of a value is removed: URL, JSON once and twice, base64 at the three alignments', () => {
    const dir = reportDir(made);
    const before = readText(dir, 'encodings.txt');
    for (const form of [encodeURIComponent(KEY), jsonOnce(PASSWORD), jsonTwice(PASSWORD)])
      expect(before).toContain(form);
    scrubDir(dir, options);
    const after = readText(dir, 'encodings.txt');
    for (const form of [KEY, encodeURIComponent(KEY), PASSWORD, jsonOnce(PASSWORD), jsonTwice(PASSWORD)]) {
      expect(after).not.toContain(form);
    }
    for (const k of [0, 1, 2]) {
      expect(after, `base64 at alignment ${k}`).not.toContain(base64At(KEY, k));
    }
    expect(after.split('[redacted]').length - 1).toBe(6);
  });

  it('`<secret>NAME</secret>` (Playwright 1.65 trace redaction) counts as already redacted', () => {
    const text = [
      'authorization: <secret>runner key</secret>',
      '{"name":"Cookie","value":"<secret>session</secret>"}',
      'Cookie: sid=<secret>session</secret>',
      '{"name":"sid","value":"<secret>session</secret>","domain":"dev.app.example"}',
    ].join('\n');
    const dir = oneFile(made, text);
    expect(scanDir(dir, { evidenceKey: EVIDENCE_KEY }).files).toEqual([]);
    const scrubbed = scrubDir(dir, { evidenceKey: EVIDENCE_KEY });
    expect(scrubbed.replaced).toBe(0);
    expect(scrubbed.collected.size).toBe(0);
    expect(readText(dir, 'out.txt')).toBe(text);
  });

  it('cookie and header names come from the config; the defaults stay', () => {
    const text = [
      'session_token=deadbeefcafe0001; Path=/',
      'x-device-key: devicekeyvalue001',
      'sid=defaultcookievalue01',
      'x-test-runner-key: runnerkeyvalue0001',
    ].join('\n');
    const dir = oneFile(made, text);
    const names = { cookieNames: ['session_token'], headerNames: ['X-Device-Key'], evidenceKey: EVIDENCE_KEY };
    const kinds = scanDir(dir, names).files.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'session-cookie')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'credential-header')).toHaveLength(1);
    scrubDir(dir, names);
    const after = readText(dir, 'out.txt');
    for (const value of ['deadbeefcafe0001', 'devicekeyvalue001', 'defaultcookievalue01', 'runnerkeyvalue0001']) {
      expect(after).not.toContain(value);
    }
    expect(after).toContain('Path=/');
  });

  it('a custom code shape is matched and checked by HMAC; without an evidence key the run id stands in', () => {
    const dir = oneFile(made, 'your code is ABCD-1234, not WXYZ-9999');
    fs.writeFileSync(path.join(dir, '.sensitive-hashes'), `${hashOf('ABCD1234', RUN)}\n`);
    const shape = { codeShape: '(?<![A-Z0-9])[A-Z]{4}-[0-9]{4}(?![A-Z0-9])' };
    expect(scanDir(dir, shape).files.map((f) => f.kind)).toEqual(['code']);
    scrubDir(dir, shape);
    expect(readText(dir, 'out.txt')).toBe('your code is [redacted-code], not WXYZ-9999');
  });

  it('codes known in plain to the process are hashed, never kept, and found like the file list', () => {
    const dir = oneFile(made, `sent ${OTHER_NUMBER} and 555 123`);
    fs.rmSync(path.join(dir, '.sensitive-hashes'));
    const scrubbed = scrubDir(dir, { codes: ['555123'], evidenceKey: EVIDENCE_KEY });
    expect(scrubbed.replaced).toBe(1);
    expect(readText(dir, 'out.txt')).toBe(`sent ${OTHER_NUMBER} and [redacted-code]`);
  });

  it('app-defined patterns are scanned under their kind and scrubbed', () => {
    const dir = oneFile(made, 'ticket TKT-00042 opened');
    const patterns = { patterns: { ticket: /TKT-\d{5}/ }, evidenceKey: EVIDENCE_KEY };
    expect(scanDir(dir, patterns).files).toEqual([{ file: 'out.txt', kind: 'ticket', count: 1 }]);
    scrubDir(dir, patterns);
    expect(readText(dir, 'out.txt')).toBe('ticket [redacted-ticket] opened');
  });
});

describe('evidence shapes the patterns once missed', () => {
  const scrubAndRead = (dir: string): { text: string; left: unknown[] } => {
    const scrubbed = scrubDir(dir, options);
    return {
      text: readText(dir, 'out.txt'),
      left: scanDir(dir, { ...options, cookieValues: scrubbed.collected }).files,
    };
  };

  it('E06 a value split by terminal colour codes (Playwright diffs) is found and redacted', () => {
    const split = `Received: "418\u001b[7m \u001b[27m203" key ${KEY.slice(0, 8)}\u001b[31m${KEY.slice(8)}`;
    const dir = oneFile(made, `${split}\n${JSON.stringify({ message: split })}`);
    const found = scanDir(dir, options).files.map((f) => f.kind);
    expect(found).toEqual(expect.arrayContaining(['code', 'secret-value']));
    const { text, left } = scrubAndRead(dir);
    expect(left).toEqual([]);
    expect(text).not.toContain('\u001b[');
    expect(text).not.toContain('203');
    expect(text.replace(/\\u001b\[[0-9;]*m/g, '')).not.toContain(KEY);
  });

  it('E07 credentials in JSON inside a JSON string are redacted by value', () => {
    const inner = JSON.stringify({
      headers: { authorization: 'Bearer abcdefghij0123', 'X-XSRF-TOKEN': 'xsrfvalue0123456' },
    });
    const dir = oneFile(made, JSON.stringify({ postData: inner }));
    const { text, left } = scrubAndRead(dir);
    expect(left).toEqual([]);
    expect(text).not.toContain('abcdefghij0123');
    expect(text).not.toContain('xsrfvalue0123456');
  });

  it("E08 a Set-Cookie line loses its value, not its attributes' words; a redacted line scans clean", () => {
    const dir = oneFile(
      made,
      'set-cookie: theme=nightmode42; Path=/; SameSite=Strict\nThe word Strict stays.\nauthorization:   [redacted]',
    );
    const { text, left } = scrubAndRead(dir);
    expect(left).toEqual([]);
    expect(text).not.toContain('nightmode42');
    expect(text).toContain('The word Strict stays.');
    expect(text).toContain('authorization:   [redacted]');
  });
});
