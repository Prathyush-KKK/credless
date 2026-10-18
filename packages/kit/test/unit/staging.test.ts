// The private staging dir: where it is per platform, 0700 and 0600 modes, the secret-file handover, and the sweep of
// what dead processes left behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPrivateDir,
  OWNER_FILE,
  openStaging,
  Staging,
  stagingDirPath,
  sweepOrphans,
} from '../../src/runner/staging.ts';

const posix = process.platform !== 'win32';
const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-staging-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('where staging is', () => {
  it('uses XDG_CACHE_HOME, then ~/.cache, on POSIX', () => {
    expect(stagingDirPath({ env: {}, platform: 'linux', homedir: '/home/x' })).toBe('/home/x/.cache/credless/staging');
    expect(stagingDirPath({ env: { XDG_CACHE_HOME: '/c' }, platform: 'darwin', homedir: '/home/x' })).toBe(
      '/c/credless/staging',
    );
  });
  it('uses LOCALAPPDATA on Windows', () => {
    const p = stagingDirPath({
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      platform: 'win32',
      homedir: 'C:\\Users\\x',
    });
    expect(p.split(path.sep).slice(-2)).toEqual(['credless', 'staging']);
  });
  it('honours the override, relative to cwd', () => {
    expect(stagingDirPath({ env: { CREDLESS_STAGING_DIR: '.staging' }, cwd: '/proj', platform: 'linux' })).toBe(
      path.resolve('/proj', '.staging'),
    );
    expect(stagingDirPath({ env: {}, override: '/elsewhere', platform: 'linux' })).toBe(path.resolve('/elsewhere'));
  });
});

describe('open and handover', () => {
  it('creates the dir private and writes secret files 0600, NUL-separated when several', () => {
    const root = tmp();
    const staging = openStaging({ env: {}, override: path.join(root, 's') });
    expect(fs.existsSync(staging.dir)).toBe(true);
    if (posix) expect(isPrivateDir(staging.dir)).toBe(true);
    const one = staging.secretFile('key', 'value-one');
    expect(path.basename(one)).toBe(`.secret-${process.pid}-key`);
    expect(fs.readFileSync(one, 'utf8')).toBe('value-one');
    if (posix) expect(fs.statSync(one).mode & 0o777).toBe(0o600);
    const two = staging.secretFile('scrub', 'alpha', 'beta');
    expect(fs.readFileSync(two, 'utf8')).toBe('alpha\0beta\0');
    expect(() => staging.secretFile('Bad Name', 'x')).toThrow(/purpose/);
    staging.release();
    expect(fs.existsSync(one)).toBe(false);
    expect(fs.existsSync(two)).toBe(false);
  });

  it('owns run folders until they are kept, and moves them out with the owner file gone', () => {
    const root = tmp();
    const staging = openStaging({ env: {}, override: path.join(root, 's') });
    const runId = '20261008T101500Z-ab12';
    const dir = staging.runDir(runId);
    expect(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim()).toBe(String(process.pid));
    fs.writeFileSync(path.join(dir, '.post-run-done'), '0');
    expect(staging.markerSays(runId, 0)).toBe(true);
    expect(staging.markerSays(runId, 1)).toBe(false);
    const dest = path.join(root, 'reports', runId);
    staging.keep(runId, dest);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(dest, '.post-run-done'))).toBe(true);
    expect(fs.existsSync(path.join(dest, OWNER_FILE))).toBe(false);
    const other = staging.runDir('20261008T101501Z-ab13');
    staging.release();
    expect(fs.existsSync(other)).toBe(false);
  });
});

describe('orphan sweep', () => {
  it('deletes secret files and run folders of dead pids and keeps the living', () => {
    const dir = tmp();
    const deadPid = 999_999;
    const alive = (pid: number) => pid === process.pid;
    fs.writeFileSync(path.join(dir, `.secret-${deadPid}-key`), 'x');
    fs.writeFileSync(path.join(dir, `.secret-${process.pid}-key`), 'x');
    fs.writeFileSync(path.join(dir, '.secret-not-a-pid'), 'x');
    const deadRun = path.join(dir, '20261008T101500Z-dead');
    fs.mkdirSync(deadRun);
    fs.writeFileSync(path.join(deadRun, OWNER_FILE), `${deadPid}\n`);
    const liveRun = path.join(dir, '20261008T101500Z-live');
    fs.mkdirSync(liveRun);
    fs.writeFileSync(path.join(liveRun, OWNER_FILE), `${process.pid}\n`);
    const unowned = path.join(dir, '20261008T101500Z-old0');
    fs.mkdirSync(unowned);
    const fresh = path.join(dir, '20261008T101500Z-new0');
    fs.mkdirSync(fresh);
    const now = Date.now();
    fs.utimesSync(unowned, new Date(now - 13 * 3600 * 1000), new Date(now - 13 * 3600 * 1000));
    const result = sweepOrphans(dir, { isAlive: alive, now });
    expect(result.secretFiles).toEqual([`.secret-${deadPid}-key`]);
    expect(result.runDirs.sort()).toEqual(['20261008T101500Z-dead', '20261008T101500Z-old0']);
    expect(fs.existsSync(path.join(dir, `.secret-${process.pid}-key`))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.secret-not-a-pid'))).toBe(true);
    expect(fs.existsSync(liveRun)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(deadRun)).toBe(false);
    expect(fs.existsSync(unowned)).toBe(false);
  });

  it('runs at open, with the real liveness check', () => {
    const root = tmp();
    const dir = path.join(root, 's');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.secret-999999-key'), 'x');
    const staging = openStaging({ env: {}, override: dir });
    expect(staging).toBeInstanceOf(Staging);
    expect(fs.existsSync(path.join(dir, '.secret-999999-key'))).toBe(false);
  });
});
