// The test-code gate catches each forbidden pattern with file and line, in both engines, and passes a clean file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTests, type Engine, listTestFiles, RULES, stripComments } from '../../src/runner/check-tests.ts';

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-gate-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const BAD: Array<[string, keyof typeof RULES]> = [
  ["import { chromium } from '@playwright/test';", 'browser-import'],
  ["import { test, webkit as wk } from '@playwright/test';", 'browser-import'],
  ["import { firefox } from 'playwright';", 'browser-import'],
  ["import * as pw from 'playwright-core';", 'browser-import'],
  ["import http from 'node:http';", 'module-import'],
  ["import https from 'https';", 'module-import'],
  ["import net from 'node:net';", 'module-import'],
  ["import tls from 'node:tls';", 'module-import'],
  ["import dgram from 'node:dgram';", 'module-import'],
  ["import { spawn } from 'node:child_process';", 'module-import'],
  ["import fs from 'node:fs';", 'module-import'],
  ["import { readFile } from 'fs/promises';", 'module-import'],
  ["const h = require('node:http');", 'module-import'],
  ["const m = await import('node:net');", 'module-import'],
  ['const b = await chromium.launch();', 'browser-launch'],
  ['const c = await browser.newContext();', 'browser-launch'],
  ['const r = await request.newContext();', 'browser-launch'],
  ['const s = await webkit.connect(url);', 'browser-launch'],
  ["test.use({ launchOptions: { args: ['--x'] } });", 'launch-option'],
  ["test.use({ proxy: { server: 'http://127.0.0.1:1' } });", 'launch-option'],
  ['test.use({ ignoreDefaultArgs: true });', 'launch-option'],
  ["const opts = { executablePath: '/usr/bin/chrome' };", 'launch-option'],
  ['const x = process.env.SECRET;', 'process'],
  ["const y = process['env'];", 'process'],
  ['process.exit(1);', 'process'],
  ["await fetch('https://outside.example/');", 'bare-fetch'],
  ["await globalThis.fetch('https://outside.example/');", 'bare-fetch'],
  ["new WebSocket('ws://127.0.0.1:4319');", 'bare-fetch'],
  ["eval('1');", 'dynamic-code'],
  ["new Function('return 1')();", 'dynamic-code'],
];

const CLEAN = `import { expect, test, about } from 'credless';
import { DemoControl } from './control.ts';

// a comment mentioning fetch( and process.env and chromium.launch( is fine
test('W1 owner shares a document with a member', async ({ personas, control }) => {
  about('docs/spec.md §3', 'the member sees the document');
  const [owner, member] = await personas.open('owner', 'member');
  const text = 'process.env is only text here, like fetch(';
  await test.step('owner shares', async () => {
    await owner.goto('/documents');
    await owner.shot('documents');
  });
  const answer = await member.api('/api/documents');
  expect(answer.http).toBe(200);
  expect(text).toContain('fetch(');
  const launch = { launched: true, proxyName: 'x' };
  expect(launch.launched).toBe(true);
});
`;

for (const engine of ['ts', 'regex'] as Engine[]) {
  describe(`${engine} engine`, () => {
    it('catches each forbidden pattern with its line', async () => {
      const dir = tmp();
      const lines = BAD.map(([code]) => code);
      fs.writeFileSync(path.join(dir, 'bad.spec.ts'), `${lines.join('\n')}\n`);
      const result = await checkTests([dir], { engine });
      expect(result.engine).toBe(engine);
      expect(result.files).toBe(1);
      for (const [index, [code, rule]] of BAD.entries()) {
        const hit = result.findings.find((f) => f.line === index + 1);
        expect(hit, `line ${index + 1}: ${code}`).toBeDefined();
        expect(hit?.rule, `line ${index + 1}: ${code}`).toBe(rule);
        expect(hit?.message).toContain(RULES[rule]);
        expect(hit?.file).toBe(path.join(dir, 'bad.spec.ts'));
      }
    });

    it('passes a clean test file, comments and strings included', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'clean.spec.ts'), CLEAN);
      fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bad.ts'), "import fs from 'node:fs';");
      const result = await checkTests([dir], { engine });
      expect(result.findings).toEqual([]);
      expect(result.files).toBe(1);
    });
  });
}

describe('helpers', () => {
  it('lists test files recursively and skips node_modules and dot dirs', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'sub', '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'));
    for (const f of [
      'a.spec.ts',
      'sub/b.ts',
      'sub/c.mjs',
      'sub/d.d.ts',
      'sub/.hidden/e.ts',
      'node_modules/f.ts',
      'readme.md',
    ])
      fs.writeFileSync(path.join(dir, f), '');
    expect(listTestFiles([dir]).map((f) => path.relative(dir, f))).toEqual([
      'a.spec.ts',
      path.join('sub', 'b.ts'),
      path.join('sub', 'c.mjs'),
    ]);
  });

  it('strips comments but not strings', () => {
    const text =
      'const a = \'http://x\'; // fetch(\n/* process.env */ const b = `//not a comment`; const c = "/* nope */";';
    const out = stripComments(text);
    expect(out).toContain("'http://x'");
    expect(out).not.toContain('fetch(');
    expect(out).not.toContain('process.env');
    expect(out).toContain('`//not a comment`');
    expect(out).toContain('"/* nope */"');
    expect(out.split('\n')).toHaveLength(2);
  });
});
