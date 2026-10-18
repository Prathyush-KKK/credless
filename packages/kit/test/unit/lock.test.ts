// The run lock per target and slot: taken by mkdir, named after its owner, taken over when the owner is gone or the
// lock is older than four hours, and held against a second run otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock, LockHeldError, lockPath, STALE_LOCK_MS } from '../../src/runner/lock.ts';

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-lock-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('run lock', () => {
  it('is a directory with the owner pid, released on demand', async () => {
    const staging = tmp();
    const lock = await acquireRunLock(staging, 'dev', 'a');
    expect(lock.dir).toBe(lockPath(staging, 'dev', 'a'));
    expect(fs.readFileSync(path.join(lock.dir, 'pid'), 'utf8').trim()).toBe(String(process.pid));
    await expect(acquireRunLock(staging, 'dev', 'a', { waitMs: 0 })).rejects.toThrow(LockHeldError);
    await expect(acquireRunLock(staging, 'dev', 'a', { waitMs: 0 })).rejects.toThrow(/another run on dev slot a/);
    // another slot or target is free
    (await acquireRunLock(staging, 'dev', 'b')).release();
    lock.release();
    expect(fs.existsSync(lock.dir)).toBe(false);
    (await acquireRunLock(staging, 'dev', 'a')).release();
  });

  it('takes over a lock whose owner is dead', async () => {
    const staging = tmp();
    const dir = lockPath(staging, 'dev', 'a');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pid'), '999999\n');
    const lock = await acquireRunLock(staging, 'dev', 'a', { isAlive: () => false });
    expect(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()).toBe(String(process.pid));
    lock.release();
  });

  it('takes over a lock older than four hours even when its pid looks alive', async () => {
    const staging = tmp();
    const dir = lockPath(staging, 'dev', 'a');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pid'), '4242\n');
    const now = Date.now();
    await expect(acquireRunLock(staging, 'dev', 'a', { isAlive: () => true, now: () => now })).rejects.toThrow(
      LockHeldError,
    );
    const lock = await acquireRunLock(staging, 'dev', 'a', { isAlive: () => true, now: () => now + STALE_LOCK_MS + 1 });
    lock.release();
  });

  it('waits for a live owner and takes the lock when it goes', async () => {
    const staging = tmp();
    const first = await acquireRunLock(staging, 'dev', 'a');
    const waits: string[] = [];
    setTimeout(() => first.release(), 120);
    const second = await acquireRunLock(staging, 'dev', 'a', {
      waitMs: 5_000,
      pollMs: 40,
      onWait: (m) => waits.push(m),
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatch(/waiting up to 1 min/);
    second.release();
  });
});
