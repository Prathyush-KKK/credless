// The argv parser and the dispatch: usage errors return EXIT.USAGE with one line on stderr, never a throw.
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../../src/runner/cli.ts';
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
    }
  });

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
