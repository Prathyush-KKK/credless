// Secrets never print (private U06–U08): whatever the channel, a wrapped value stays [redacted].
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import {
  addRedactionCookies,
  addRedactionHeaders,
  redact,
  registerSecretValue,
  runnerKeyFromRunner,
  Secret,
  sanitizedError,
  secretFromFile,
  signinPasswordFromRunner,
  timingSafeEqualString,
} from '../../src/core/secret.ts';
import { ENV } from '../../src/types.ts';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-secret-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Secret', () => {
  test('says [redacted] however it is printed; reveal() is the only way to the value', () => {
    const secret = new Secret('k3y-value-that-must-not-print', 'runner key');
    expect(String(secret)).toBe('runner key=[redacted]');
    expect(`${secret}`).not.toContain('k3y-value');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(util.inspect({ secret })).not.toContain('k3y-value');
    expect(util.inspect(secret)).toBe('Secret(runner key)');
    expect(Object.keys(secret)).toEqual(['label']);
    expect(secret.reveal()).toBe('k3y-value-that-must-not-print');
  });

  test('an empty value is refused, and the refusal names the label only', () => {
    expect(() => new Secret('', 'sign-in password')).toThrow('empty secret: sign-in password');
  });

  test('a thrown Error built around a secret is redacted by sanitizedError', () => {
    const secret = new Secret('another-secret-value-42', 'k');
    const raw = new Error(`connect ECONNREFUSED\nCall log:\n  - x-test-runner-key: ${secret.reveal()}`);
    const clean = sanitizedError(raw, 'test API');
    expect(clean.message).toBe('test API: connect ECONNREFUSED');
    expect(clean.stack ?? '').not.toContain('another-secret-value-42');
    expect(sanitizedError('plain string failure', 'ctx').message).toBe('ctx: plain string failure');
  });
});

describe('redact()', () => {
  test('strips registered values (and their URL-encoded form), JWTs and credential headers', () => {
    registerSecretValue('cookie value/123456');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhMC5vd25lciIsIm4iOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU';
    const text = [
      'sid=cookie%20value%2F123456; other',
      `bearer ${jwt}`,
      'X-Test-Runner-Key: abcdef123',
      'x-test-broker-token=tok-en-value',
      'cookie: a=b; c=d',
      'Authorization: Bearer xyz',
      '{"set-cookie":"sid=zzz; Path=/"}',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('123456');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('abcdef123');
    expect(out).not.toContain('tok-en-value');
    expect(out).not.toContain('a=b; c=d');
    expect(out).not.toContain('Bearer xyz');
    expect(out).not.toContain('sid=zzz');
    expect(out).toContain('[redacted]');
  });

  test('values shorter than six characters are not registered (they would redact ordinary words)', () => {
    registerSecretValue('ab1');
    expect(redact('ab1 is fine')).toBe('ab1 is fine');
  });

  test('configured header and cookie names join the rules', () => {
    addRedactionHeaders('X-App-Key');
    addRedactionCookies('sid', 'csrf');
    const out = redact('X-App-Key: app-key-value\nSet by login: sid=session-value-here; csrf=tok; Path=/');
    expect(out).not.toContain('app-key-value');
    expect(out).not.toContain('session-value-here');
    expect(out).toContain('csrf=[redacted]');
  });
});

describe('timingSafeEqualString', () => {
  test('equal strings only, whatever the length', () => {
    expect(timingSafeEqualString('abc-def', 'abc-def')).toBe(true);
    expect(timingSafeEqualString('abc-def', 'abc-deg')).toBe(false);
    expect(timingSafeEqualString('abc', 'abc-def')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });
});

describe('secrets from files and the handover', () => {
  test('secretFromFile reads a private file, trims, and can delete it; a missing file is null', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, 'the-file-key-value\n', { mode: 0o600 });
    const kept = secretFromFile(file, 'runner key');
    expect(kept?.reveal()).toBe('the-file-key-value');
    expect(fs.existsSync(file)).toBe(true);
    const taken = secretFromFile(file, 'runner key', { deleteAfter: true });
    expect(taken?.reveal()).toBe('the-file-key-value');
    expect(fs.existsSync(file)).toBe(false);
    expect(secretFromFile(file, 'runner key')).toBeNull();
  });

  test.skipIf(!posix)('a file readable by others is refused on POSIX, and still deleted when asked', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, 'world-readable-key', { mode: 0o644 });
    expect(() => secretFromFile(file, 'runner key')).toThrow(/readable by others/);
    expect(() => secretFromFile(file, 'runner key', { deleteAfter: true })).toThrow(/0600/);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, 'world-readable-key', { mode: 0o644 });
    // advisory on Windows: the same file passes when the platform says so
    expect(secretFromFile(file, 'runner key', { platform: 'win32' })?.reveal()).toBe('world-readable-key');
  });

  test('runnerKeyFromRunner reads the handover file once, deletes it, and removes the variables', () => {
    const dir = tmpDir();
    const file = path.join(dir, '.secret-123-key');
    fs.writeFileSync(file, 'handed-over-key-value\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { [ENV.RUNNER_KEY_FILE]: file, [ENV.RUNNER_KEY]: 'env-copy-that-must-go' };
    const key = runnerKeyFromRunner(env);
    expect(key?.reveal()).toBe('handed-over-key-value');
    expect(fs.existsSync(file)).toBe(false);
    expect(env[ENV.RUNNER_KEY_FILE]).toBeUndefined();
    expect(env[ENV.RUNNER_KEY]).toBeUndefined();
  });

  test('runnerKeyFromRunner falls back to the environment variable and takes it over; null when there is nothing', () => {
    const env: NodeJS.ProcessEnv = { [ENV.RUNNER_KEY]: ' env-key-value ' };
    expect(runnerKeyFromRunner(env)?.reveal()).toBe('env-key-value');
    expect(env[ENV.RUNNER_KEY]).toBeUndefined();
    expect(runnerKeyFromRunner({})).toBeNull();
    const dir = tmpDir();
    const missing: NodeJS.ProcessEnv = { [ENV.RUNNER_KEY_FILE]: path.join(dir, 'gone') };
    expect(runnerKeyFromRunner(missing)).toBeNull();
    expect(missing[ENV.RUNNER_KEY_FILE]).toBeUndefined();
  });

  test('signinPasswordFromRunner: the file first (deleted), else the self-tests stand-in, else null', () => {
    const dir = tmpDir();
    const file = path.join(dir, '.secret-123-signin');
    fs.writeFileSync(file, 'file-password-value', { mode: 0o600 });
    expect(
      signinPasswordFromRunner({ [ENV.SIGNIN_PASSWORD_FILE]: file, [ENV.SIGNIN_PASSWORD]: 'ignored-env' })?.reveal(),
    ).toBe('file-password-value');
    expect(fs.existsSync(file)).toBe(false);
    expect(signinPasswordFromRunner({ [ENV.SIGNIN_PASSWORD]: 'stand-in-password' })?.reveal()).toBe(
      'stand-in-password',
    );
    expect(signinPasswordFromRunner({})).toBeNull();
  });
});
