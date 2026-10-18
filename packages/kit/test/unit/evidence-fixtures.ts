// Synthetic run folders for the evidence tests, built the way the private self-tests built theirs: stand-in values
// only, generic hosts and the default cookie names. Not a test file (vitest collects `*.test.ts`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

export const RUN = '20261008T101500Z-ev01';
export const EVIDENCE_KEY = 'evidence-key-for-the-unit-test';
/** a stand-in runner key with characters that URL-encode differently from the plain form */
export const KEY = 'standin/runner+key=7b3e9c1a';
/** a stand-in sign-in password with a quote and a backslash, so JSON escaping changes it */
export const PASSWORD = 'stand"in-pass\\word-4d2f';
export const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhMC5vd25lciIsInJ1biI6ImV2MDEifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmUtMTIz';
export const CODE = '418203';
/** a six-digit number the run never handed out: must survive */
export const OTHER_NUMBER = '271044';
export const CSRF = 'abcdef0123456789';
export const OTHER_COOKIE = 'zzzzzzzzzzzz';

export function tempDir(made: string[], prefix = 'evidence-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function cleanup(made: string[]): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function hashOf(code: string, key: string = EVIDENCE_KEY): string {
  return crypto.createHmac('sha256', key).update(code).digest('hex');
}

export const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The JSON-escaped form of a value, once and twice. */
export const jsonOnce = (value: string): string => JSON.stringify(value).slice(1, -1);
export const jsonTwice = (value: string): string => jsonOnce(jsonOnce(value));

/** A base64 stream in which `value` starts at byte offset `k` (mod 3). */
export const base64At = (value: string, k: number): string => base64(`${'p'.repeat(k)}${value}-tail`);

/**
 * A run folder with every hiding place the scrub knows: a trace zip (network, cookies, a DOM snapshot, a nested zip),
 * results.json with a base64 attachment body, the HTML report with its embedded zip, and a text file with every
 * encoding of the key and the password.
 */
export function reportDir(made: string[]): string {
  const dir = tempDir(made);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: RUN, target: 'selftest' }));
  fs.writeFileSync(path.join(dir, '.sensitive-hashes'), `${hashOf(CODE)}\n`);
  const network = JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: {
        headers: [
          { name: 'Cookie', value: `sid=${JWT}; csrf=${CSRF}` },
          { name: 'accept', value: '*/*' },
        ],
        postData: { text: `{"code":"${CODE}","ref":"${OTHER_NUMBER}"}` },
      },
    },
  });
  const trace = JSON.stringify({
    method: 'addCookies',
    params: {
      cookies: [
        { name: 'sid', value: JWT, domain: 'dev.app.example', path: '/' },
        { name: 'csrf', value: CSRF, domain: 'dev.app.example', path: '/' },
        { name: 'other_cookie', value: OTHER_COOKIE, domain: 'dev.app.example', path: '/' },
      ],
    },
  });
  const snapshot = `<div id="code">418 203</div><div>418 203</div><div>418-203</div><p>order ${OTHER_NUMBER}</p>`;
  const nested = zipSync({ 'inner.txt': strToU8(`nested key ${KEY}`) });
  const zip = zipSync({
    '0-trace.network': strToU8(network),
    '0-trace.trace': strToU8(trace),
    'resources/snap.html': strToU8(snapshot),
    'nested.zip': nested,
  });
  fs.mkdirSync(path.join(dir, 'artifacts', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 't1', 'trace.zip'), zip);
  fs.writeFileSync(
    path.join(dir, 'results.json'),
    JSON.stringify({
      errors: [`x-test-runner-key: ${KEY}`],
      attachments: [{ name: 'a', contentType: 'text/plain', body: base64(`calls with key ${KEY}`) }],
    }),
  );
  const embedded = Buffer.from(
    zipSync({ 'report.json': strToU8(JSON.stringify({ stdout: `token ${JWT}` })) }),
  ).toString('base64');
  fs.mkdirSync(path.join(dir, 'html'));
  fs.writeFileSync(
    path.join(dir, 'html', 'index.html'),
    `<script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,${embedded}</script>`,
  );
  fs.writeFileSync(
    path.join(dir, 'encodings.txt'),
    [
      `url=${encodeURIComponent(KEY)}`,
      `json=${jsonOnce(PASSWORD)}`,
      `twice=${jsonTwice(PASSWORD)}`,
      `b64_0=${base64At(KEY, 0)}`,
      `b64_1=${base64At(KEY, 1)}`,
      `b64_2=${base64At(KEY, 2)}`,
    ].join('\n'),
  );
  return dir;
}

/** A report folder holding just one text file, with the run's code list. */
export function oneFile(made: string[], text: string, name = 'out.txt'): string {
  const dir = tempDir(made);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: RUN }));
  fs.writeFileSync(path.join(dir, '.sensitive-hashes'), `${hashOf(CODE)}\n`);
  fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** A run folder as post-run sees it: run.json, and results.json with one test (passing unless told otherwise). */
export function runFolder(made: string[], options: { results?: boolean; skipped?: boolean } = {}): string {
  const dir = tempDir(made, 'runner-');
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({ runId: '20261008T101500Z-rn01', target: 'selftest', slot: 'a' }),
  );
  if (options.results !== false) {
    const status = options.skipped ? 'skipped' : 'expected';
    const expectedStatus = options.skipped ? 'skipped' : 'passed';
    const spec = {
      title: 'T01 passes',
      file: 't.spec.ts',
      tests: [
        {
          projectName: 'selftest',
          status,
          expectedStatus,
          annotations: [],
          results: [{ duration: 1, errors: [], attachments: [] }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(dir, 'results.json'),
      JSON.stringify({
        config: { projects: [{ name: 'selftest' }] },
        suites: [{ title: 't.spec.ts', file: 't.spec.ts', specs: [spec] }],
        errors: [],
      }),
    );
  }
  return dir;
}

/** One spec of a hand-written results.json: a title, its attachments and errors, in one project. */
export function spec(
  title: string,
  attachments: object[],
  errors: string[] = [],
  project = 'chromium-desktop',
  annotations: Array<{ type: string; description?: string }> = [],
): object {
  return {
    title,
    file: 'real.spec.ts',
    tests: [
      {
        projectName: project,
        status: errors.length ? 'unexpected' : 'expected',
        expectedStatus: 'passed',
        annotations,
        results: [{ duration: 1, errors: errors.map((message) => ({ message })), attachments }],
      },
    ],
  };
}

export function writeResults(dir: string, projects: string[], specs: object[]): void {
  fs.writeFileSync(
    path.join(dir, 'results.json'),
    JSON.stringify({
      config: { projects: projects.map((name) => ({ name })) },
      suites: [{ title: 'real.spec.ts', file: 'real.spec.ts', specs }],
      errors: [],
    }),
  );
}

/** A 1x1 PNG, enough for a contact sheet and a hash check. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const readText = (dir: string, ...rel: string[]): string => fs.readFileSync(path.join(dir, ...rel), 'utf8');
