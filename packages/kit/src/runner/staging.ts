// The private staging directory (docs/conventions.md §8): a 0700 directory per user where the run's evidence lives
// until post-run has scrubbed it, and where secrets are handed over as 0600 files for the seconds between the CLI
// and the process that reads them. Everything here is named after the owning process, so a run that died too hard
// for its handlers (kill -9, a reboot) is cleaned up by the next one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT_NAME } from '../brand.ts';
import { ENV, EVIDENCE, PATTERNS } from '../types.ts';

/** Unfinished run folders older than this are deleted at start even when their owner cannot be told (no `.owner`). */
export const STALE_RUN_MS = 12 * 60 * 60 * 1000;
/** The file inside a staging run folder naming the CLI process that made it; removed before the folder is kept. */
export const OWNER_FILE = '.owner';

export interface StagingPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** `CREDLESS_STAGING_DIR` or `evidence.stagingDir`; a relative path is resolved against `cwd` */
  override?: string;
  cwd?: string;
}

/**
 * Where staging is: the override, else `%LOCALAPPDATA%\<kit>\staging` on Windows, else `$XDG_CACHE_HOME/<kit>/staging`
 * or `~/.cache/<kit>/staging`.
 */
export function stagingDirPath(options: StagingPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  const override = options.override ?? env[ENV.STAGING_DIR];
  if (override) return path.resolve(options.cwd ?? process.cwd(), override);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, KIT_NAME, 'staging');
  }
  const cache = env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, KIT_NAME, 'staging');
}

/** True when a process with this pid exists (EPERM means it exists and belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  isAlive?: (pid: number) => boolean;
  now?: number;
}

export interface SweepResult {
  secretFiles: string[];
  runDirs: string[];
}

const SECRET_FILE = /^\.secret-(\d+)-[a-z0-9-]+$/;

/**
 * Delete what dead runs left behind: `.secret-<pid>-*` files whose pid is gone, and run folders whose `.owner` is
 * gone (or, without one, older than {@link STALE_RUN_MS}). A run folder in staging was never scrubbed to completion,
 * so it is deleted, never kept.
 */
export function sweepOrphans(dir: string, options: SweepOptions = {}): SweepResult {
  const alive = options.isAlive ?? isPidAlive;
  const now = options.now ?? Date.now();
  const result: SweepResult = { secretFiles: [], runDirs: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const secret = SECRET_FILE.exec(entry.name);
    if (secret && entry.isFile()) {
      if (!alive(Number(secret[1]))) {
        fs.rmSync(full, { force: true });
        result.secretFiles.push(entry.name);
      }
      continue;
    }
    if (!entry.isDirectory() || !PATTERNS.runId.test(entry.name)) continue;
    let owner: number | null = null;
    try {
      owner = Number(fs.readFileSync(path.join(full, OWNER_FILE), 'utf8').trim());
    } catch {
      owner = null;
    }
    let stale = false;
    if (owner !== null && Number.isInteger(owner)) {
      stale = !alive(owner);
    } else {
      try {
        stale = now - fs.statSync(full).mtimeMs > STALE_RUN_MS;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      fs.rmSync(full, { recursive: true, force: true });
      result.runDirs.push(entry.name);
    }
  }
  return result;
}

/** A process's handle on the staging dir: secret files and run folders it owns, released together. */
export class Staging {
  readonly dir: string;
  readonly #pid: number;
  readonly #runDirs = new Set<string>();

  constructor(dir: string, pid: number = process.pid) {
    this.dir = dir;
    this.#pid = pid;
  }

  /**
   * Write secret values to a new 0600 file `.secret-<pid>-<purpose>` (`O_CREAT|O_EXCL`); several values are
   * NUL-separated. Returns the path. The value never touches a command line: callers pass the PATH in an environment
   * variable and the reader deletes the file.
   */
  secretFile(purpose: string, ...values: string[]): string {
    if (!/^[a-z0-9-]+$/.test(purpose)) throw new Error(`secret file purpose must be [a-z0-9-]: ${purpose}`);
    const file = path.join(this.dir, `.secret-${this.#pid}-${purpose}`);
    const body = values.length === 1 ? values[0] : values.map((v) => `${v}\0`).join('');
    // A leftover with this process's own pid can only be ours (pids are not reused while we live): replace it.
    fs.rmSync(file, { force: true });
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, body ?? '');
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  /** Create `<staging>/<runId>` (0700) with this process as its owner; deleted by {@link release} unless {@link keep} was called. */
  runDir(runId: string): string {
    if (!PATTERNS.runId.test(runId)) throw new Error(`not a run id: ${runId}`);
    const dir = path.join(this.dir, runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, OWNER_FILE), `${this.#pid}\n`, { mode: 0o600 });
    this.#runDirs.add(runId);
    return dir;
  }

  /** The run folders this process still owns in staging. */
  get runDirs(): string[] {
    return [...this.#runDirs];
  }

  /** Remove a run folder from staging (it never reached the marker). */
  removeRun(runId: string): void {
    fs.rmSync(path.join(this.dir, runId), { recursive: true, force: true });
    this.#runDirs.delete(runId);
  }

  /**
   * Move a finished run folder out of staging to `dest` (its `.owner` file removed first). Rename when the two are
   * on one filesystem, copy and delete otherwise.
   */
  keep(runId: string, dest: string): void {
    const src = path.join(this.dir, runId);
    fs.rmSync(path.join(src, OWNER_FILE), { force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(src, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    this.#runDirs.delete(runId);
  }

  /** Whether a run folder carries post-run's marker with this exit code. */
  markerSays(runId: string, code: number): boolean {
    try {
      return fs.readFileSync(path.join(this.dir, runId, EVIDENCE.marker), 'utf8').trim() === String(code);
    } catch {
      return false;
    }
  }

  /** Delete this process's secret files and every run folder it still owns. Safe to call twice. */
  release(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const prefix = `.secret-${this.#pid}-`;
    for (const name of names) {
      if (name.startsWith(prefix)) fs.rmSync(path.join(this.dir, name), { force: true });
    }
    for (const runId of this.#runDirs) fs.rmSync(path.join(this.dir, runId), { recursive: true, force: true });
    this.#runDirs.clear();
  }
}

export interface OpenStagingOptions extends StagingPathOptions, SweepOptions {
  pid?: number;
}

/** Create the staging dir (0700; the mode is advisory on Windows), sweep what dead processes left, and return a handle. */
export function openStaging(options: OpenStagingOptions = {}): Staging {
  const dir = stagingDirPath(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((options.platform ?? process.platform) !== 'win32') fs.chmodSync(dir, 0o700);
  sweepOrphans(dir, options);
  return new Staging(dir, options.pid);
}

/** Whether a directory is private (mode 0700). Always true on Windows, where mode bits are advisory. */
export function isPrivateDir(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return true;
  try {
    return (fs.statSync(dir).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

type CleanupFn = () => void;

/**
 * Cleanup that runs once, on a normal exit and on HUP, INT and TERM (then exits with 128 + the signal's number).
 * Functions run in reverse order of registration and must be synchronous: a signal handler gets no second chance.
 */
export class Cleanup {
  readonly #fns: CleanupFn[] = [];
  #done = false;
  #installed = false;

  add(fn: CleanupFn): void {
    this.#fns.push(fn);
  }

  run(): void {
    if (this.#done) return;
    this.#done = true;
    for (const fn of this.#fns.reverse()) {
      try {
        fn();
      } catch {
        // a failing cleanup must not stop the others
      }
    }
  }

  /** Register the process handlers (once). */
  install(): void {
    if (this.#installed) return;
    this.#installed = true;
    process.once('exit', () => this.run());
    const signals: Array<[NodeJS.Signals, number]> = [
      ['SIGHUP', 1],
      ['SIGINT', 2],
      ['SIGTERM', 15],
    ];
    for (const [signal, number] of signals) {
      process.once(signal, () => {
        this.run();
        process.exit(128 + number);
      });
    }
  }
}
