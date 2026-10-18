// The CLI runs when it is the program, also through npm's bin symlink (`node_modules/.bin/credless ->
// ../credless/dist/cli.js`, where argv[1] is the link), and stays inert when imported. Before the fix every command
// run through the symlink printed nothing and exited 0.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isEntryScript } from '../../src/runner/entry.ts';
import { CLI, KIT_ROOT } from './helpers/tmp-project.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-entry-'));
  dirs.push(dir);
  return dir;
}

/** A symlink to `target`, or null where the platform refuses one (Windows without developer mode). */
function link(target: string, at: string): string | null {
  try {
    fs.symlinkSync(target, at, 'file');
    return at;
  } catch {
    return null;
  }
}

const version = (JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'package.json'), 'utf8')) as { version: string })
  .version;

describe('isEntryScript', () => {
  it('matches the module itself and the module through a symlink', () => {
    const url = pathToFileURL(CLI).href;
    expect(isEntryScript(url, CLI)).toBe(true);
    const bin = link(CLI, path.join(tempDir(), 'credless'));
    if (bin) expect(isEntryScript(url, bin)).toBe(true);
  });

  it('does not match another file, a missing argv[1] or a path that does not exist', () => {
    const url = pathToFileURL(CLI).href;
    expect(isEntryScript(url, path.join(KIT_ROOT, 'package.json'))).toBe(false);
    expect(isEntryScript(url, undefined)).toBe(false);
    expect(isEntryScript(url, '')).toBe(false);
    expect(isEntryScript(url, path.join(tempDir(), 'gone.js'))).toBe(false);
    expect(isEntryScript('not a url', CLI)).toBe(false);
  });

  it('compares case-insensitively on Windows only', () => {
    const url = pathToFileURL(CLI).href;
    const upper = CLI.toUpperCase();
    if (upper !== CLI && !fs.existsSync(upper)) {
      expect(isEntryScript(url, upper, 'linux')).toBe(false);
      expect(isEntryScript(url, upper, 'win32')).toBe(true);
    }
  });
});

describe('the CLI through a bin symlink', () => {
  // The layout npm makes: <project>/node_modules/.bin/credless -> the real entry script.
  const viaSymlink = (args: string[]) => {
    const binDir = path.join(tempDir(), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = link(CLI, path.join(binDir, 'credless'));
    if (!bin) return null;
    return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  };

  it('--help prints the usage and exits 0', () => {
    const r = viaSymlink(['--help']);
    if (!r) return; // no symlinks on this machine
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage: credless <command>');
  });

  it('version prints the package version', () => {
    const r = viaSymlink(['version']);
    if (!r) return;
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`credless ${version}`);
  });

  it('an unknown command reaches main(): usage on stderr, exit 2', () => {
    const r = viaSymlink(['no-such-command']);
    if (!r) return;
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown command: no-such-command');
  });
});
