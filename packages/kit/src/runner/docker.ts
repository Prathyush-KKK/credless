// Docker mode: the suite runs in the official Playwright image whose tag matches the installed Playwright, pinned by
// digest when the table below knows one (plan §6 T11). The project is bind-mounted at /work and the staging dir at
// /staging; the container gets an explicit environment allowlist and nothing else. v0.1 has no `--isolate`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { RunMode } from '../types.ts';

export const DOCKER_WORK = '/work';
export const DOCKER_STAGING = '/staging';

/**
 * Digests of the Playwright images the runner knows, by Playwright version. A `null` is a tag the runner uses
 * unpinned (doctor says "unpinned"); it is never guessed. Fill a row from
 * `docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble` and check it against the release.
 */
export const IMAGE_DIGESTS: Readonly<Record<string, string | null>> = {
  // TODO(T11): pin once verified against the published manifest list; v0.1 ships the tag.
  '1.64.1': null,
};

export interface ImageRef {
  /** what `docker run` gets: `repo:tag@sha256:...` when pinned, `repo:tag` otherwise */
  ref: string;
  tag: string;
  pinned: boolean;
}

/** The installed `@playwright/test` version as seen from `projectRoot`, or null. */
export function playwrightVersion(projectRoot: string): string | null {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    const pkg = require('@playwright/test/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** The image for a Playwright version (or the one the config names), pinned when the table has its digest. */
export function imageFor(version: string | null, configured?: string): ImageRef {
  const tag = configured ?? `mcr.microsoft.com/playwright:v${version ?? 'unknown'}-noble`;
  const digest = version && !configured ? (IMAGE_DIGESTS[version] ?? null) : null;
  return { ref: digest ? `${tag}@${digest}` : tag, tag, pinned: digest !== null };
}

/** True when `docker` is on PATH (the daemon may still be down: see {@link dockerAvailable}). */
export function dockerOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, `docker${ext.toLowerCase()}`), fs.constants.X_OK);
        return true;
      } catch {
        // next
      }
    }
  }
  return false;
}

/** True inside a container already (then runs are native). */
export function insideContainer(): boolean {
  return fs.existsSync('/.dockerenv');
}

/** `docker info` must succeed: an installed but stopped Docker means a native run, not a failed one. */
export function dockerAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (insideContainer() || !dockerOnPath(env)) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 15_000, windowsHide: true }, (error) => resolve(!error));
  });
}

/** Whether the image is already pulled (presence only). */
export function imagePulled(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['images', '-q', image], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      resolve(!error && String(stdout).trim().length > 0);
    });
  });
}

/** A path inside staging as the run sees it: `/staging/...` in docker mode, unchanged natively. */
export function inRun(mode: RunMode, stagingDir: string, p: string): string {
  if (mode !== 'docker') return p;
  const rel = path.relative(stagingDir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${p} is not inside staging ${stagingDir}`);
  return `${DOCKER_STAGING}/${rel.split(path.sep).join('/')}`;
}

/** A path inside the project as the container sees it, or null when it is outside the project. */
export function inWork(projectRoot: string, p: string): string | null {
  const rel = path.relative(projectRoot, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel ? `${DOCKER_WORK}/${rel.split(path.sep).join('/')}` : DOCKER_WORK;
}

export interface DockerRunOptions {
  image: string;
  projectRoot: string;
  stagingDir: string;
  /** name=value pairs the container gets (paths, flags: never a secret value) */
  env: Record<string, string>;
  /** names the docker CLI reads from its own environment (`-e NAME`): keeps their values off the command line */
  passNames?: string[];
  ipcHost?: boolean;
  command: string[];
}

/** The argv of `docker run` for a run step: `--rm --init`, the allowlisted env, the three mounts, the image, the command. */
export function dockerRunArgs(options: DockerRunOptions): string[] {
  const args = ['run', '--rm', '--init'];
  if (options.ipcHost) args.push('--ipc=host');
  for (const name of options.passNames ?? []) args.push('-e', name);
  for (const [name, value] of Object.entries(options.env)) args.push('-e', `${name}=${value}`);
  args.push('-v', `${options.projectRoot}:${DOCKER_WORK}`);
  args.push('-v', `${options.stagingDir}:${DOCKER_STAGING}`);
  args.push('-w', DOCKER_WORK, options.image, ...options.command);
  return args;
}
