// Runs a real `playwright test` as a child process with a stand-in secret planted everywhere a test can put one,
// and looks for it afterwards independently of the pipeline under test. Lives outside test/selftest because the spec
// files there may not touch the file system or spawn processes (biome's override, plan §6 F3); this helper is the
// one place the evidence self-test does, and only against its own temporary project.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The stand-in secret the child test plants; it never leaves these self-tests. */
export const STANDIN = 'standin-secret-E09-9f3a7c1d2e';

export interface ChildRun {
  /** the temporary project and its evidence, deleted by {@link removeDir} */
  root: string;
  /** the run folder the reporters wrote into */
  dir: string;
  status: number | null;
  stdout: string;
  stderr: string;
  /** whether the child opened a page (a Chromium was installed), so a trace exists too */
  withBrowser: boolean;
}

function browserAvailable(): boolean {
  try {
    const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function ctrfReporter(): string | null {
  try {
    require.resolve('playwright-ctrf-json-reporter');
    return 'playwright-ctrf-json-reporter';
  } catch {
    return null;
  }
}

/** The child's spec: a failing test that puts the stand-in into a step title, a fill, attachments, stdout and the error. */
function specSource(withBrowser: boolean): string {
  const lines = [
    "import { expect, test } from '@playwright/test';",
    `const SECRET = ${JSON.stringify(STANDIN)};`,
    `test('plants a stand-in secret everywhere a test can put one', async ({ ${withBrowser ? 'page' : ''} }, testInfo) => {`,
    withBrowser
      ? '  await page.setContent(\'<input id="p" type="password"><p>screen with \' + SECRET + \'</p>\');'
      : '',
    "  await test.step('fill \"' + SECRET + '\" into the password field', async () => {",
    withBrowser ? "    await page.fill('#p', SECRET);" : '',
    '  });',
    "  await testInfo.attach('note', { body: 'token ' + SECRET, contentType: 'text/plain' });",
    "  await testInfo.attach('calls.json', { body: JSON.stringify({ headers: { authorization: 'Bearer ' + SECRET } }), contentType: 'application/json' });",
    "  console.log('stdout carries ' + SECRET);",
    "  expect('got ' + SECRET).toBe('something else');",
    '});',
  ];
  return `${lines.filter((l) => l !== '').join('\n')}\n`;
}

/** Run the child suite with the html, json, junit, blob (and CTRF when installed) reporters into a fresh folder. */
export function runChildSuite(): ChildRun {
  const root = path.join(KIT_DIR, 'test-results', `e09-${crypto.randomBytes(3).toString('hex')}`);
  const project = path.join(root, 'project');
  const dir = path.join(root, 'run');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const withBrowser = browserAvailable();
  const ctrf = ctrfReporter();
  const reporter: Array<[string, Record<string, unknown>]> = [
    ['html', { outputFolder: path.join(dir, 'html'), open: 'never' }],
    ['json', { outputFile: path.join(dir, 'results.json') }],
    ['junit', { outputFile: path.join(dir, 'junit.xml') }],
    ['blob', { outputDir: path.join(dir, 'blob'), fileName: 'report.zip' }],
  ];
  if (ctrf) reporter.push([ctrf, { outputDir: dir, outputFile: 'ctrf.json' }]);
  const config = {
    testDir: '.',
    outputDir: path.join(dir, 'artifacts'),
    reporter,
    retries: 0,
    workers: 1,
    use: withBrowser ? { trace: 'on' } : {},
  };
  fs.writeFileSync(path.join(project, 'playwright.config.mjs'), `export default ${JSON.stringify(config)};\n`);
  fs.writeFileSync(path.join(project, 'planted.spec.mjs'), specSource(withBrowser));
  const env: Record<string, string> = { CI: '1' };
  for (const name of [
    'PATH',
    'HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
    'TMPDIR',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const result = spawnSync(
    process.execPath,
    [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(project, 'playwright.config.mjs')],
    { cwd: project, env, encoding: 'utf8', timeout: 180_000 },
  );
  return { root, dir, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', withBrowser };
}

/**
 * Every place a needle appears under a folder, looking inside zips, zips inside zips and the base64 zips embedded in
 * text files; written apart from the pipeline, so the proof does not rely on the code under test.
 */
export function deepContains(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const bytesNeedle = Buffer.from(needle, 'utf8');
  const look = (bytes: Uint8Array, label: string): void => {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.includes(bytesNeedle)) hits.push(label);
    if (label.endsWith('.zip')) {
      try {
        for (const [name, data] of Object.entries(unzipSync(bytes))) look(data, `${label}!${name}`);
      } catch {
        hits.push(`${label} (unreadable zip)`);
      }
      return;
    }
    const text = buf.toString('latin1');
    for (const m of text.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)) {
      look(Buffer.from(m[1] ?? '', 'base64'), `${label}#embedded.zip`);
    }
  };
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) look(fs.readFileSync(full), path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return hits;
}

export function readText(dir: string, ...rel: string[]): string {
  return fs.readFileSync(path.join(dir, ...rel), 'utf8');
}

export function fileExists(dir: string, ...rel: string[]): boolean {
  return fs.existsSync(path.join(dir, ...rel));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A run folder with two projects and three tiny screenshots (one a triage shot), for the contact sheets. */
export function shotsFolder(): string {
  const dir = fs.mkdtempSync(path.join(KIT_DIR, 'test-results', 'sheets-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const test = (project: string): object => ({
    title: 'W1 home',
    file: 'w.spec.ts',
    tests: [
      {
        projectName: project,
        status: 'expected',
        expectedStatus: 'passed',
        annotations: [],
        results: [{ duration: 1, errors: [], attachments: [] }],
      },
    ],
  });
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({ runId: '20261008T101500Z-sh01', target: 'selftest', slot: 'a' }),
  );
  fs.writeFileSync(
    path.join(dir, 'results.json'),
    JSON.stringify({
      config: {
        projects: [
          { name: 'desktop', metadata: { size: 'desktop' } },
          { name: 'mobile', metadata: { size: 'mobile' } },
        ],
      },
      suites: [{ title: 'w.spec.ts', file: 'w.spec.ts', specs: [test('desktop'), test('mobile')] }],
      errors: [],
    }),
  );
  fs.mkdirSync(path.join(dir, 'shots'));
  fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-home-desktop.png'), png);
  fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-home-mobile.png'), png);
  fs.writeFileSync(path.join(dir, 'shots', 'W1-home--owner-FAILED-desktop.png'), png);
  return dir;
}
