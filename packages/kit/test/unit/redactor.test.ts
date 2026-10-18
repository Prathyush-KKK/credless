// The redacting stream for a child's stdout and stderr (port of the private E03, which piped through `filter`).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactor, redactString } from '../../src/evidence/redactor.ts';
import { CODE, cleanup, EVIDENCE_KEY, hashOf, JWT, KEY, OTHER_NUMBER, oneFile } from './evidence-fixtures.ts';

const made: string[] = [];
afterEach(() => cleanup(made));

async function through(redactor: Redactor, chunks: string[]): Promise<string> {
  const out: Buffer[] = [];
  const source = Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')));
  await new Promise<void>((resolve, reject) => {
    source
      .pipe(redactor)
      .on('data', (chunk: Buffer) => out.push(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return Buffer.concat(out).toString('utf8');
}

describe('redactor', () => {
  it("E03 the console filter redacts a run's output line by line", async () => {
    const dir = oneFile(made, '');
    const input = [
      `Error: "${CODE}" is not on screen`,
      `cookie: sid=${JWT}`,
      `key ${KEY} here`,
      `order ${OTHER_NUMBER}`,
      '',
    ].join('\n');
    const out = await through(new Redactor({ dir, values: [KEY], evidenceKey: EVIDENCE_KEY }), [input]);
    expect(out).not.toContain(CODE);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(KEY);
    expect(out).toContain(`order ${OTHER_NUMBER}`);
    expect(out.split('\n')).toHaveLength(5);
  });

  it('lines split across chunks and a last line without a newline are handled', async () => {
    const out = await through(new Redactor({ values: [KEY] }), [
      'first ke',
      `y ${KEY.slice(0, 5)}`,
      `${KEY.slice(5)} end\nsecond ${KEY}`,
    ]);
    expect(out).toBe('first key [redacted] end\nsecond [redacted]');
  });

  it('a coloured line without a secret keeps its colours; one with a secret split by colour codes is written plain', async () => {
    const clean = '\u001b[32m  ✓ \u001b[0m 1 test passed';
    const split = `Received: "418\u001b[7m \u001b[27m203" key ${KEY.slice(0, 8)}\u001b[31m${KEY.slice(8)}\u001b[0m`;
    const dir = oneFile(made, '');
    const out = await through(new Redactor({ dir, values: [KEY], evidenceKey: EVIDENCE_KEY }), [
      `${clean}\n${split}\n`,
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe(clean);
    expect(lines[1]).toBe('Received: "[redacted-code]" key [redacted]');
  });

  it('codes handed out while the run goes on are picked up from the growing hash list', async () => {
    const dir = oneFile(made, '');
    fs.rmSync(path.join(dir, '.sensitive-hashes'));
    const redactor = new Redactor({ dir, evidenceKey: EVIDENCE_KEY });
    expect(redactor.redactLine(`code ${CODE} before`)).toBe(`code ${CODE} before`);
    fs.writeFileSync(path.join(dir, '.sensitive-hashes'), `${hashOf(CODE)}\n`);
    expect(redactor.redactLine(`code ${CODE} after`)).toBe('code [redacted-code] after');
  });

  it('a value registered after the stream started is redacted from then on; cookie values seen once are redacted later', () => {
    const redactor = new Redactor();
    expect(redactor.redactLine(`key ${KEY}`)).toBe(`key ${KEY}`);
    redactor.add({ label: 'runner key', reveal: () => KEY });
    expect(redactor.redactLine(`key ${KEY}`)).toBe('key [redacted]');
    expect(redactor.redactLine('set-cookie: sid=sessionvalue0001; Path=/')).toBe('set-cookie: sid=[redacted]; Path=/');
    expect(redactor.redactLine('later: sessionvalue0001 again')).toBe('later: [redacted] again');
  });

  it('redactString takes a whole text and tells secret-shaped tokens from ordinary numbers', () => {
    const text = `header line\nauthorization: Bearer tokenvalue0001\nx-test-runner-key: ${KEY}\nnumber ${OTHER_NUMBER}`;
    const out = redactString(text, { values: [KEY] });
    expect(out).toBe(`header line\nauthorization: [redacted]\nx-test-runner-key: [redacted]\nnumber ${OTHER_NUMBER}`);
  });
});
