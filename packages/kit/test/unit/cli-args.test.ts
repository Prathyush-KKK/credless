// The argv parser and the dispatch: usage errors return EXIT.USAGE with one line on stderr, never a throw.

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, commandHelp, main, parseArgs, suggestCommand } from '../../src/runner/cli.ts';
import { EXIT } from '../../src/types.ts';
import { cli, makeProject, type TempProject } from './helpers/tmp-project.ts';

const made: TempProject[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.cleanup();
});

describe('parseArgs', () => {
  it('reads long options with and without =, booleans, --no-, aliases and --', () => {
    const p = parseArgs(['--target', 'dev', '--workers=4', '--twice', '--no-docker', '-h', 'pos', '--', '-g', 'x'], {
      booleans: ['twice', 'docker', 'help'],
      strings: ['target', 'workers'],
      aliases: { h: 'help' },
    });
    expect(p).toEqual({
      flags: { target: 'dev', workers: '4', twice: true, docker: false, help: true },
      positionals: ['pos'],
      passthrough: ['-g', 'x'],
    });
  });
  it('refuses unknown options and missing values unless loose', () => {
    expect(parseArgs(['--bogus'])).toEqual({ error: 'unknown option: --bogus' });
    expect(parseArgs(['-x'])).toEqual({ error: 'unknown option: -x' });
    expect(parseArgs(['--target'], { strings: ['target'] })).toEqual({ error: '--target needs a value' });
    expect(parseArgs(['--twice=maybe'], { booleans: ['twice'] })).toEqual({ error: '--twice takes no value' });
    const loose = parseArgs(['--target', 'dev', '-g', 'W1', '--grep-invert', 'slow', '--headed', 'file.spec.ts'], {
      strings: ['target'],
      loose: true,
    });
    expect(loose).toEqual({
      flags: { target: 'dev' },
      positionals: [],
      passthrough: ['-g', 'W1', '--grep-invert', 'slow', '--headed', 'file.spec.ts'],
    });
  });
});

const io = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => {
    out += c.toString();
  });
  stderr.on('data', (c: Buffer) => {
    err += c.toString();
  });
  return { stdout, stderr, out: () => out, err: () => err };
};

describe('main', () => {
  it('prints usage for no command, help and unknown commands', async () => {
    const none = io();
    expect(await main([], none)).toBe(EXIT.USAGE);
    expect(none.err()).toContain('Usage: credless');
    const help = io();
    expect(await main(['--help'], help)).toBe(EXIT.PASS);
    expect(help.out()).toContain('Exit codes');
    const bad = io();
    expect(await main(['nope'], bad)).toBe(EXIT.USAGE);
    expect(bad.err()).toMatch(/^credless: unknown command: nope/);
    const version = io();
    expect(await main(['version'], version)).toBe(EXIT.PASS);
    expect(version.out()).toMatch(/^credless \d+\.\d+\.\d+/);
  });

  it('refuses usage errors with code 2 and one line', async () => {
    for (const argv of [
      ['run'],
      ['run', '--target', 'dev', '--docker', '--native'],
      ['run', '--target', 'dev', '--workers', 'x'],
      ['health'],
      ['report', 'nope'],
      ['evidence', 'scan'],
      ['mcp'],
      ['doctor', '--bogus'],
    ]) {
      const t = io();
      expect(await main(argv, t), argv.join(' ')).toBe(EXIT.USAGE);
      expect(t.err(), argv.join(' ')).toMatch(/^credless: /);
      // one line and a pointer, never the whole command list
      expect(t.err(), argv.join(' ')).not.toContain('Exit codes');
      expect(t.err().trim().split('\n').length, argv.join(' ')).toBeLessThanOrEqual(2);
    }
  });

  it("help <command>, <command> --help and -h print that command's usage and examples", async () => {
    for (const name of Object.keys(COMMANDS)) {
      const text = commandHelp(name);
      expect(text, name).toMatch(new RegExp(`^Usage: credless ${name}`));
      expect(text, name).toMatch(/\nExamples:\n {2}credless /);
    }
    for (const argv of [
      ['help', 'run'],
      ['run', '--help'],
      ['run', '-h'],
      ['run', '--target', 'dev', '--help'],
    ]) {
      const t = io();
      expect(await main(argv, t), argv.join(' ')).toBe(EXIT.PASS);
      expect(t.out(), argv.join(' ')).toMatch(/^Usage: credless run --target t/);
    }
    // after --, --help belongs to Playwright: the run goes on (and stops for want of a config here)
    const passthrough = io();
    await main(['run', '--target', 'dev', '--', '--help'], {
      ...passthrough,
      env: {},
      cwd: path.parse(process.cwd()).root,
    });
    expect(passthrough.out()).not.toContain('Usage: credless run');
    const demo = io();
    expect(await main(['demo', '--help'], demo)).toBe(EXIT.PASS);
    expect(demo.out()).toContain('--plant-secret');
  });

  it('suggests the command a typo was close to, and nothing for a far one', async () => {
    expect(suggestCommand('rnu')).toBe('run');
    expect(suggestCommand('docter')).toBe('doctor');
    expect(suggestCommand('repotr')).toBe('report');
    expect(suggestCommand('check-test')).toBe('check-tests');
    expect(suggestCommand('xyzzy')).toBeNull();
    const typo = io();
    expect(await main(['doctr'], typo)).toBe(EXIT.USAGE);
    expect(typo.err()).toMatch(/^credless: unknown command: doctr\ncredless: did you mean "doctor"\?/);
    const topic = io();
    expect(await main(['help', 'seeed'], topic)).toBe(EXIT.USAGE);
    expect(topic.err()).toMatch(/no command "seeed"; did you mean "seed"\?/);
  });

  it('report list, and report summary defaulting to the latest run', async () => {
    const p = makeProject();
    made.push(p);
    const empty = io();
    expect(await main(['report'], { ...empty, cwd: p.dir })).toBe(EXIT.USAGE);
    expect(empty.err()).toMatch(/no runs in .*reports yet/);
    const reports = path.join(p.dir, 'reports');
    for (const [id, verdict] of [
      ['20261018T100000Z-aaaa', 'FAIL'],
      ['20261018T110000Z-bbbb', 'PASS'],
    ] as const) {
      fs.mkdirSync(path.join(reports, id), { recursive: true });
      fs.writeFileSync(path.join(reports, id, 'SUMMARY.md'), `# Run ${id}: ${verdict}\n\nbody of ${id}\n`);
    }
    fs.mkdirSync(path.join(reports, 'not-a-run'));
    const list = io();
    expect(await main(['report', 'list'], { ...list, cwd: p.dir })).toBe(EXIT.PASS);
    expect(list.out().trim().split('\n')).toEqual([
      `20261018T110000Z-bbbb  PASS    ${path.join('reports', '20261018T110000Z-bbbb')}`,
      `20261018T100000Z-aaaa  FAIL    ${path.join('reports', '20261018T100000Z-aaaa')}`,
    ]);
    const latest = io();
    expect(await main(['report'], { ...latest, cwd: p.dir })).toBe(EXIT.PASS);
    expect(latest.out()).toContain('body of 20261018T110000Z-bbbb');
    const named = io();
    expect(await main(['report', 'summary', '20261018T100000Z-aaaa'], { ...named, cwd: p.dir })).toBe(EXIT.PASS);
    expect(named.out()).toContain('body of 20261018T100000Z-aaaa');
  }, 60_000);

  it('runs check-tests on a directory and exits 1 on findings, 0 when clean', async () => {
    const p = makeProject({ playwright: true });
    made.push(p);
    const clean = cli(p, ['check-tests', 'e2e']);
    expect(clean.status, clean.all).toBe(0);
    expect(clean.stdout).toMatch(/1 file\(s\), 0 finding\(s\)/);
    const r = cli(p, ['check-tests', 'playwright.config.ts']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/playwright\.config\.ts:\d+:\d+: process:/);
    expect(cli(p, ['check-tests', 'nowhere']).status).toBe(2);
  }, 60_000);

  it('--isolate is refused in v0.1 before anything else', () => {
    const p = makeProject();
    made.push(p);
    const r = cli(p, ['run', '--target', 'dev', '--isolate']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--isolate .* v0\.2/);
  }, 60_000);
});
