// Secrets in the kit: the runner key, the broker token, the session cookies the test API mints, one-time codes
// and the sign-in persona's password. None of them may reach a log line, an error message, a report, a trace, a
// screenshot name or an attachment, because the agent reads all of those.
//
// Two mechanisms:
//  - `Secret` wraps a value so that printing, string conversion and JSON serialisation all say [redacted]; code
//    has to call reveal() on purpose, in the one place that sends it.
//  - every revealed value is registered, and redact() replaces any registered value (and anything shaped like
//    a JWT, a credential header or a session cookie) wherever text leaves the process.

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { DEFAULTS, ENV, type SecretValue } from '../types.ts';

export const REDACTED = '[redacted]';
const registered = new Set<string>();

/** A value that must never be printed. reveal() is the only way to read it. */
export class Secret implements SecretValue {
  readonly #value: string;
  readonly label: string;

  constructor(value: string, label: string) {
    if (!value) throw new Error(`empty secret: ${label}`);
    this.#value = value;
    this.label = label;
    registerSecretValue(value);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `${this.label}=${REDACTED}`;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${this.label})`;
  }
}

/** Remember a value so redact() strips it from any text. Values shorter than 6 characters are ignored. */
export function registerSecretValue(value: string | undefined | null): void {
  if (!value || value.length < 6) return;
  registered.add(value);
  // the URL-encoded form appears in cookie headers and query strings
  const encoded = encodeURIComponent(value);
  if (encoded !== value) registered.add(encoded);
}

/** For the self-tests: how many values are registered (never the values). */
export function registeredSecretCount(): number {
  return registered.size;
}

/** Hand every registered value to a consumer that must scrub by value (post-run); the only way out of the set. */
export function forEachRegisteredSecret(consumer: (value: string) => void): void {
  for (const value of registered) consumer(value);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Header names whose values are credentials wherever they appear in text (`Name: value`, `name=value`, JSON).
const credentialHeaders = new Set<string>([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  DEFAULTS.keyHeader.toLowerCase(),
  DEFAULTS.brokerTokenHeader.toLowerCase(),
]);
// Cookie names whose `name=value` pairs are sessions (`AppSignals.sessionCookies`, the CSRF cookie).
const sessionCookies = new Set<string>();

/** Tell the redactor about a configured header (`testApi.keyHeader`, a CSRF header) so its value is never printed. */
export function addRedactionHeaders(...names: string[]): void {
  for (const name of names) if (name) credentialHeaders.add(name.toLowerCase());
}

/** Tell the redactor about the app's session cookie names, so `name=value` pairs are redacted in any text. */
export function addRedactionCookies(...names: string[]): void {
  for (const name of names) if (name) sessionCookies.add(name);
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

function headerPattern(): RegExp {
  const names = [...credentialHeaders].map(escapeRegExp).join('|');
  return new RegExp(`((?:^|[\\s"'{,])(?:${names})["']?\\s*[:=]\\s*["']?)[^\\n"']+`, 'gi');
}

function cookiePattern(): RegExp | null {
  if (sessionCookies.size === 0) return null;
  const names = [...sessionCookies].map(escapeRegExp).join('|');
  return new RegExp(`((?:^|[\\s;"'])(?:${names})=)[^;\\s"']+`, 'g');
}

/** Text safe to print: registered secret values and credential-shaped strings replaced. */
export function redact(text: string): string {
  let out = text;
  for (const value of registered) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  out = out.replace(JWT, '[redacted-jwt]');
  out = out.replace(headerPattern(), `$1${REDACTED}`);
  const cookies = cookiePattern();
  if (cookies) out = out.replace(cookies, `$1${REDACTED}`);
  return out;
}

/** An Error whose message and stack are redacted; the original (which may quote headers) is dropped. */
export function sanitizedError(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright and undici append call logs and causes that can list request headers: keep the first line only.
  const first = message.split('\n')[0] ?? '';
  const clean = new Error(redact(`${context}: ${first}`));
  clean.stack = clean.stack ? redact(clean.stack.split('\n').slice(0, 1).join('\n')) : undefined;
  return clean;
}

/** Constant-time string equality for tokens and keys; a length difference is not a timing oracle either. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // compare something of equal length anyway, so the time taken does not depend on where they differ
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface SecretFileOptions {
  /** remove the file once read (the handover files of docs/conventions.md, "Secrets") */
  deleteAfter?: boolean;
  /** refuse a file readable by group or others; POSIX only, mode bits are advisory on Windows (default true) */
  requirePrivate?: boolean;
  /** injected in tests */
  platform?: NodeJS.Platform;
}

/**
 * Is a mode private to its owner? Always true on Windows, where mode bits are advisory (`doctor` says so); on POSIX
 * group and other must have no bits at all.
 */
export function isPrivateMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return true;
  return (mode & 0o077) === 0;
}

/**
 * Read a secret from a file, trimmed, as a Secret. The file must be private to its owner on POSIX. With
 * `deleteAfter` it is removed in a `finally`, so a failure never leaves a copy behind. Null when the file is
 * missing or empty.
 */
export function secretFromFile(file: string, label: string, options: SecretFileOptions = {}): Secret | null {
  const { deleteAfter = false, requirePrivate = true, platform = process.platform } = options;
  let raw = '';
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (requirePrivate && !isPrivateMode(stat.mode, platform)) {
      throw new Error(
        `refused: ${file} is readable by others (mode ${(stat.mode & 0o777).toString(8)}); it must be 0600`,
      );
    }
    raw = fs.readFileSync(file, 'utf8').trim();
  } finally {
    if (deleteAfter) fs.rmSync(file, { force: true });
  }
  return raw ? new Secret(raw, label) : null;
}

/**
 * The runner key as the CLI hands it over: a 0600 file in the private staging dir, named by `ENV.RUNNER_KEY_FILE`,
 * read once and deleted at once, so no environment (this process's, a worker's, a container's) holds the key
 * after this returns. Falls back to `ENV.RUNNER_KEY` in the environment (the `env` key source's variable, for a
 * process that was not started by the CLI) and removes that too. Null when neither is set.
 */
export function runnerKeyFromRunner(env: NodeJS.ProcessEnv = process.env, platform?: NodeJS.Platform): Secret | null {
  const file = env[ENV.RUNNER_KEY_FILE];
  // the environment copy goes whichever source wins: nothing spawned after this may inherit it
  const fromEnv = env[ENV.RUNNER_KEY]?.trim();
  delete env[ENV.RUNNER_KEY];
  let fromFile: Secret | null = null;
  if (file) {
    try {
      fromFile = secretFromFile(file, 'runner key', { deleteAfter: true, platform });
    } finally {
      delete env[ENV.RUNNER_KEY_FILE];
    }
  }
  if (fromFile) return fromFile;
  return fromEnv ? new Secret(fromEnv, 'runner key') : null;
}

/**
 * The sign-in persona's password as the runner gives it to the one UI sign-in test: the 0600 file named by
 * `ENV.SIGNIN_PASSWORD_FILE` (read once and deleted), or `ENV.SIGNIN_PASSWORD` (the self-tests' stand-in). Null
 * when absent, so a suite without a password persona needs nothing.
 */
export function signinPasswordFromRunner(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<SecretFileOptions, 'deleteAfter' | 'platform'> = {},
): Secret | null {
  const file = env[ENV.SIGNIN_PASSWORD_FILE];
  if (file) {
    const password = secretFromFile(file, 'sign-in password', {
      deleteAfter: options.deleteAfter ?? true,
      platform: options.platform,
    });
    if (password) return password;
  }
  const raw = env[ENV.SIGNIN_PASSWORD]?.trim();
  return raw ? new Secret(raw, 'sign-in password') : null;
}
