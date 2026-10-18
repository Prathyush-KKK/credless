// One run per target and slot at a time (docs/conventions.md §8): a second run would reset the first one's accounts
// and end its sessions. The lock is a directory (`mkdir` is atomic on every filesystem) holding the owner's pid; a
// lock whose owner is gone, or that is older than four hours, is taken over at once.
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive } from './staging.ts';

/** A lock older than this is stale whatever its pid file says (a pid can be recycled). */
export const STALE_LOCK_MS = 4 * 60 * 60 * 1000;

export interface RunLock {
  readonly dir: string;
  release(): void;
}

export class LockHeldError extends Error {
  override readonly name = 'LockHeldError';
}

export interface AcquireLockOptions {
  /** how long to wait for a live owner before giving up (default 0: give up at once) */
  waitMs?: number;
  /** how often to retry while waiting (default 15 s) */
  pollMs?: number;
  staleMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** told once when waiting starts */
  onWait?: (message: string) => void;
  pid?: number;
}

/** The lock directory for a target and slot inside staging. */
export function lockPath(stagingDir: string, target: string, slot: string): string {
  return path.join(stagingDir, `.lock-${target}-${slot}`);
}

function ownerOf(dir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function ageOf(dir: string, now: number): number {
  try {
    return now - fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Take the lock for `target` and `slot`, waiting up to `waitMs` for a live owner. Throws {@link LockHeldError} when
 * the wait runs out. The pid file is written right after the directory, so a crash in between leaves a lock with no
 * owner, which the next run takes over as stale after {@link STALE_LOCK_MS}.
 */
export async function acquireRunLock(
  stagingDir: string,
  target: string,
  slot: string,
  options: AcquireLockOptions = {},
): Promise<RunLock> {
  const dir = lockPath(stagingDir, target, slot);
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 15_000;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const alive = options.isAlive ?? isPidAlive;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  let waited = 0;
  let announced = false;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), `${pid}\n`);
      return {
        dir,
        release: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = ownerOf(dir);
    // A dead owner, or a lock old enough that its pid may be somebody else's by now: take it over.
    if (
      (owner !== null && !alive(owner)) ||
      ageOf(dir, now()) > staleMs ||
      (owner === null && ageOf(dir, now()) > 60_000)
    ) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (waited >= waitMs) {
      throw new LockHeldError(
        `another run on ${target} slot ${slot} is in progress (lock ${dir}); use --wait <minutes>, or another --slot`,
      );
    }
    if (!announced) {
      announced = true;
      options.onWait?.(
        `a run on ${target} slot ${slot} is in progress; waiting up to ${Math.ceil(waitMs / 60_000)} min`,
      );
    }
    const step = Math.min(pollMs, waitMs - waited);
    await new Promise((resolve) => setTimeout(resolve, step));
    waited += step;
  }
}
