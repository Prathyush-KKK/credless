// Q02: against a remote target the runner never guesses a slot; the slot comes from --slot, CREDLESS_SLOT or the slot
// file, in that order, is one lowercase letter, and is checked before any secret is read.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSlot, resolveSlot, SlotError, slotFilePath } from '../../src/runner/slot.ts';
import { cli, configSource, makeProject, type TempProject } from './helpers/tmp-project.ts';

const made: TempProject[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.cleanup();
});
const project = (options?: Parameters<typeof makeProject>[0]) => {
  const p = makeProject(options);
  made.push(p);
  return p;
};

describe('slot file path', () => {
  it('follows XDG on POSIX and APPDATA on Windows', () => {
    expect(slotFilePath({ env: {}, platform: 'linux', homedir: '/home/x' })).toBe('/home/x/.config/credless/slot');
    expect(slotFilePath({ env: { XDG_CONFIG_HOME: '/cfg' }, platform: 'linux', homedir: '/home/x' })).toBe(
      '/cfg/credless/slot',
    );
    const win = slotFilePath({
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      platform: 'win32',
      homedir: 'C:\\Users\\x',
    });
    expect(win.split(path.sep).slice(-2)).toEqual(['credless', 'slot']);
  });
});

describe('resolution and checks', () => {
  it('prefers --slot, then the environment, then the file', () => {
    const p = project();
    const file = path.join(p.dir, 'slot');
    fs.writeFileSync(file, 'f\n');
    expect(resolveSlot({ flag: 'b', env: { CREDLESS_SLOT: 'c' }, file })).toMatchObject({ slot: 'b', source: 'flag' });
    expect(resolveSlot({ env: { CREDLESS_SLOT: 'c' }, file })).toMatchObject({ slot: 'c', source: 'env' });
    expect(resolveSlot({ env: {}, file })).toMatchObject({ slot: 'f', source: 'file' });
    expect(resolveSlot({ env: {}, file: path.join(p.dir, 'missing') })).toMatchObject({ slot: null, source: 'none' });
  });

  it('defaults to a for local targets and for health, never for a remote target', () => {
    const none = resolveSlot({ env: {}, file: '/nonexistent/slot' });
    expect(checkSlot(none, { target: 'selftest', local: true })).toEqual({ slot: 'a', source: 'default' });
    expect(checkSlot(none, { target: 'dev', local: false, needsNone: true })).toEqual({ slot: 'a', source: 'default' });
    expect(() => checkSlot(none, { target: 'dev', local: false })).toThrow(/no slot for dev/);
    expect(() => checkSlot(none, { target: 'dev', local: false })).toThrow(SlotError);
  });

  it('refuses anything but one lowercase letter (the file is trimmed, a flag is not)', () => {
    expect(
      resolveSlot({
        env: {},
        file: (() => {
          const p = project();
          const file = path.join(p.dir, 'slot');
          fs.writeFileSync(file, ' g \r\n');
          return file;
        })(),
      }).slot,
    ).toBe('g');
    for (const bad of ['ff', 'A', '1', 'a ', '']) {
      const r = resolveSlot({ flag: bad || undefined, env: { CREDLESS_SLOT: bad }, file: '/nonexistent/slot' });
      if (bad === '') expect(r.slot).toBeNull();
      else expect(() => checkSlot(r, { target: 'dev', local: false })).toThrow(/one lowercase letter/);
    }
  });
});

describe('Q02 through the CLI', () => {
  it('stops before any secret: no slot, then no key; the slot file counts; a bad letter is refused', () => {
    const p = project();
    const noSlot = /no slot for dev: run `credless slot <letter>`/;
    const noKey = /no runner key: CREDLESS_RUNNER_KEY is not set\. To fix: set CREDLESS_RUNNER_KEY/;
    const tests = cli(p, ['run', '--target', 'dev', '--native']);
    expect(tests.status, tests.all).toBe(2);
    expect(tests.stderr).toMatch(noSlot);
    expect(cli(p, ['seed', '--target', 'dev']).stderr).toMatch(noSlot);
    // health touches no account, so it needs no slot; it goes on to the key (and stops there: none is set)
    expect(cli(p, ['health', '--target', 'dev']).stderr).toMatch(noKey);
    expect(cli(p, ['run', '--target', 'dev', '--native', '--slot', 'e']).stderr).toMatch(noKey);
    const file = path.join(p.home, '.config', 'credless', 'slot');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'f\n');
    expect(cli(p, ['run', '--target', 'dev', '--native']).stderr).toMatch(noKey);
    fs.writeFileSync(file, 'ff\n');
    const bad = cli(p, ['run', '--target', 'dev', '--native']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/one lowercase letter/);
    // a local target needs no slot and reads no key: it gets as far as Playwright
    const local = cli(p, ['run', '--target', 'selftest', '--native']);
    expect(local.stderr).not.toMatch(noSlot);
    expect(local.stderr).not.toMatch(noKey);
  }, 180_000);

  it('`credless slot` shows, sets and refuses a slot, and a run then uses it', () => {
    const p = project();
    const file = path.join(p.home, '.config', 'credless', 'slot');
    expect(cli(p, ['slot']).stdout).toMatch(/no slot set on this machine; `credless slot <letter>` sets one/);
    const upper = cli(p, ['slot', 'E']);
    expect(upper.status).toBe(2);
    expect(upper.stderr).toMatch(/one lowercase letter, a to z \(got "E"\)/);
    expect(upper.stderr).toContain('Run `credless help slot`');
    expect(fs.existsSync(file)).toBe(false);
    const set = cli(p, ['slot', 'g']);
    expect(set.status, set.all).toBe(0);
    expect(set.stdout).toMatch(/slot g written to .*: runs from this machine use the accounts of namespaces g0, g1/);
    expect(fs.readFileSync(file, 'utf8')).toBe('g\n');
    expect(cli(p, ['slot']).stdout).toMatch(/^slot g \(from .*slot\)/);
    // past the slot question: a run now stops at the key
    expect(cli(p, ['run', '--target', 'dev', '--native']).stderr).toMatch(/no runner key/);
    fs.writeFileSync(file, 'gg\n');
    const malformed = cli(p, ['slot']);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toMatch(/one lowercase letter .*got "gg".*`credless slot <letter>` replaces the file/);
  }, 120_000);

  it('refuses a production-shaped target before the slot question', () => {
    const p = project();
    // The loader refuses the whole config once a target points at production, whichever target is asked for.
    fs.writeFileSync(
      p.configFile,
      configSource({
        reportsDir: p.reportsDir,
        extraTargets: ["prodlike: { web: 'https://app.prod.example', api: 'https://api.prod.example' },"],
      }),
    );
    const r = cli(p, ['run', '--target', 'prodlike', '--native', '--slot', 'e']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/production/);
  });
});
