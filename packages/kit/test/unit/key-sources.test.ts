// Key sources: `describe()` never runs anything or reads a value; `read()` hands back a Secret and leaves no copy
// behind it does not own; `exec` runs argv without a shell and never prints what came back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  createKeySource,
  createMailSink,
  createSessionProvider,
  resolveSignals,
  Secret,
} from '../../src/adapters/index.ts';
import { envKeySource } from '../../src/adapters/key/env.ts';
import { EXEC_PRESETS, execArgv, execKeySource } from '../../src/adapters/key/exec.ts';
import { fileKeySource } from '../../src/adapters/key/file.ts';
import { keySource } from '../../src/adapters/key/index.ts';
import { keyringKeySource } from '../../src/adapters/key/keyring.ts';
import { defaultSignals } from '../../src/adapters/signals.ts';
import { ENV } from '../../src/types.ts';

const node = process.execPath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-keys-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('env', () => {
  test('describe() reports presence only; read() takes the variable over and deletes it', async () => {
    const env: NodeJS.ProcessEnv = { [ENV.RUNNER_KEY]: ' env-runner-key-value ' };
    const source = envKeySource({ source: 'env' }, env);
    expect(source.name).toBe('env');
    expect(source.describe()).toBe(`env ${ENV.RUNNER_KEY} (set)`);
    expect(env[ENV.RUNNER_KEY]).toBeDefined();
    const key = await source.read();
    expect(key).toBeInstanceOf(Secret);
    expect(key.reveal()).toBe('env-runner-key-value');
    expect(env[ENV.RUNNER_KEY]).toBeUndefined();
    expect(source.describe()).toBe(`env ${ENV.RUNNER_KEY} (not set)`);
    await expect(source.read()).rejects.toThrow(`no runner key: ${ENV.RUNNER_KEY} is not set`);
    const custom = envKeySource({ source: 'env', name: 'MY_KEY' }, { MY_KEY: 'custom-value' });
    expect((await custom.read()).reveal()).toBe('custom-value');
  });
});

describe('file', () => {
  test('reads a private file and leaves it; describes a missing or loose file without reading it', async () => {
    const file = path.join(dir, 'runner.key');
    fs.writeFileSync(file, 'file-runner-key-value\n', { mode: 0o600 });
    const source = fileKeySource({ source: 'file', path: file }, 'linux');
    expect(source.describe()).toBe(`file ${file} (private)`);
    expect((await source.read()).reveal()).toBe('file-runner-key-value');
    expect(fs.existsSync(file)).toBe(true);
    const missing = fileKeySource({ source: 'file', path: path.join(dir, 'nope') });
    expect(missing.describe()).toMatch(/\(missing\)$/);
    await expect(missing.read()).rejects.toThrow(/missing or empty/);
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      expect(source.describe()).toMatch(/mode 644, must be 0600/);
      await expect(source.read()).rejects.toThrow(/readable by others/);
      expect(fileKeySource({ source: 'file', path: file }, 'win32').describe()).toMatch(/advisory on Windows/);
    }
  });
});

describe('exec', () => {
  test('runs argv with no shell: metacharacters stay literal, stdout is the key, trimmed', async () => {
    const source = execKeySource({
      source: 'exec',
      argv: [node, '-e', 'process.stdout.write(process.argv[1] + "\\n")', '$HOME;echo pwned|cat `id` && exit 9'],
    });
    expect(source.name).toBe('exec');
    const key = await source.read();
    expect(key.reveal()).toBe('$HOME;echo pwned|cat `id` && exit 9');
    const plain = execKeySource({ source: 'exec', argv: [node, '-e', 'console.log("  exec-key-value  ")'] });
    expect((await plain.read()).reveal()).toBe('exec-key-value');
  });

  test('describe() names the command and never runs it', () => {
    const source = execKeySource({ source: 'exec', argv: ['definitely-not-a-command-xyz', '--boom'] });
    expect(source.describe()).toBe('exec definitely-not-a-command-xyz --boom (argv; not run by doctor)');
    expect(execKeySource({ source: 'exec', preset: 'op', ref: 'op://vault/item/field' }).describe()).toBe(
      'exec op read --no-newline op://vault/item/field (preset op; not run by doctor)',
    );
  });

  test('a failing command is reported with its code, never with what it printed', async () => {
    const value = 'leaked-key-value-123456';
    const source = execKeySource({
      source: 'exec',
      argv: [
        node,
        '-e',
        `process.stdout.write("${value}"); process.stderr.write("secret ${value} is wrong\\nmore"); process.exit(3)`,
      ],
    });
    const error = await source.read().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/failed \(3\)/);
    expect(error?.message).toContain('secret [redacted] is wrong');
    expect(error?.message).not.toContain(value);
    expect(error?.message).not.toContain('more');
    await expect(execKeySource({ source: 'exec', argv: [node, '-e', ''] }).read()).rejects.toThrow(/printed nothing/);
    await expect(execKeySource({ source: 'exec', argv: ['definitely-not-a-command-xyz'] }).read()).rejects.toThrow(
      /definitely-not-a-command-xyz failed/,
    );
  });

  test('presets are argv templates; kubectl output is base64 and decoded', async () => {
    expect(execArgv({ source: 'exec', preset: 'op', ref: 'op://v/i/f' }).argv).toEqual([
      'op',
      'read',
      '--no-newline',
      'op://v/i/f',
    ]);
    expect(execArgv({ source: 'exec', preset: 'infisical', ref: 'RUNNER_KEY' }).argv).toEqual([
      'infisical',
      'secrets',
      'get',
      'RUNNER_KEY',
      '--plain',
      '--silent',
    ]);
    expect(execArgv({ source: 'exec', preset: 'doppler', ref: 'RUNNER_KEY' }).argv).toEqual([
      'doppler',
      'secrets',
      'get',
      'RUNNER_KEY',
      '--plain',
    ]);
    expect(execArgv({ source: 'exec', preset: 'vault', ref: 'secret/e2e/runner#key' }).argv).toEqual([
      'vault',
      'kv',
      'get',
      '-field=key',
      'secret/e2e/runner',
    ]);
    expect(execArgv({ source: 'exec', preset: 'vault', ref: 'secret/e2e/runner' }).argv).toEqual([
      'vault',
      'kv',
      'get',
      '-field=value',
      'secret/e2e/runner',
    ]);
    expect(execArgv({ source: 'exec', preset: 'kubectl', ref: 'e2e/runner#api.key' })).toEqual({
      argv: ['kubectl', 'get', 'secret', 'runner', '-n', 'e2e', '-o', 'jsonpath={.data.api\\.key}'],
      decode: 'base64',
    });
    expect(execArgv({ source: 'exec', preset: 'kubectl', ref: 'runner#key' }).argv).toEqual([
      'kubectl',
      'get',
      'secret',
      'runner',
      '-o',
      'jsonpath={.data.key}',
    ]);
    expect(() => execArgv({ source: 'exec', preset: 'kubectl', ref: 'runner' })).toThrow(/secret-name#key/);
    expect(() => execArgv({ source: 'exec', preset: 'op' })).toThrow(/either argv/);
    expect(Object.keys(EXEC_PRESETS).sort()).toEqual(['doppler', 'infisical', 'kubectl', 'op', 'vault']);
    // the decode step, with node standing in for kubectl
    const argv = [node, '-e', `process.stdout.write(Buffer.from("decoded-key-value").toString("base64"))`];
    const decoded = execKeySource({ source: 'exec', argv });
    expect((await decoded.read()).reveal()).toBe(Buffer.from('decoded-key-value').toString('base64'));
    const viaPreset = execKeySource({ source: 'exec', preset: 'kubectl', ref: 'runner#key' });
    const preset = EXEC_PRESETS.kubectl;
    expect(preset.decode).toBe('base64');
    expect(viaPreset.describe()).toContain('kubectl get secret runner');
  });
});

describe('keyring', () => {
  test('describe() says whether the optional module is there; read() loads it or explains', async () => {
    const ref = { source: 'keyring' as const, service: 'kit', account: 'runner' };
    expect(keyringKeySource(ref).describe()).toMatch(
      /^keyring kit\/runner \(@napi-rs\/keyring (installed|is not installed)/,
    );
    const missing = keyringKeySource(ref, async () => {
      throw new Error('Cannot find module');
    });
    await expect(missing.read()).rejects.toThrow(/@napi-rs\/keyring is not installed/);
    const fake = keyringKeySource(ref, async () => ({
      Entry: class {
        readonly service: string;
        readonly account: string;
        constructor(service: string, account: string) {
          this.service = service;
          this.account = account;
        }
        getPassword() {
          return this.service === 'kit' && this.account === 'runner' ? 'keyring-key-value' : null;
        }
      },
    }));
    expect((await fake.read()).reveal()).toBe('keyring-key-value');
    const empty = keyringKeySource({ ...ref, account: 'other' }, async () => ({
      Entry: class {
        getPassword() {
          return null;
        }
      },
    }));
    await expect(empty.read()).rejects.toThrow(/no entry kit\/other/);
  });
});

describe('the factories', () => {
  test('dispatch on the reference, and the stub names are aliases', () => {
    expect(keySource({ source: 'env' }).name).toBe('env');
    expect(keySource({ source: 'file', path: 'x' }).name).toBe('file');
    expect(keySource({ source: 'exec', argv: ['x'] }).name).toBe('exec');
    expect(keySource({ source: 'keyring', service: 's', account: 'a' }).name).toBe('keyring');
    expect(() => keySource({ source: 'vault' } as never)).toThrow(/unknown key source vault/);
    expect(createKeySource).toBe(keySource);
    expect(createSessionProvider({ provider: 'test-api' }).name).toBe('test-api');
    expect(createSessionProvider({ provider: 'storage-state-file', dir }).name).toBe('storage-state-file');
    expect(() => createSessionProvider({ provider: 'module', module: './x.js' })).toThrow(/loadSessionProvider/);
    expect(createMailSink({ sink: 'mailpit', url: 'http://127.0.0.1:8025' }).name).toBe('mailpit');
    expect(() => createMailSink({ sink: 'test-api' })).toThrow(/needs \{ api, handleFor \}/);
    expect(resolveSignals).toBe(defaultSignals);
  });

  test('default signals: sid, 401 on the api origin, status >= 400', () => {
    const signals = defaultSignals({}, { apiOrigin: 'https://dev-api.example.com/' });
    expect(signals.sessionCookies).toEqual(['sid']);
    expect(signals.unexpectedSignOut({ url: new URL('https://dev-api.example.com/me'), status: 401 })).toBe(true);
    expect(signals.unexpectedSignOut({ url: new URL('https://dev.example.com/me'), status: 401 })).toBe(false);
    expect(signals.unexpectedSignOut({ url: new URL('https://dev-api.example.com/me'), status: 403 })).toBe(false);
    expect(signals.apiError({ url: new URL('https://dev-api.example.com/x'), status: 404 })).toBe(404);
    expect(signals.apiError({ url: new URL('https://dev-api.example.com/x'), status: 204 })).toBeNull();
    expect(signals.csrf).toBeUndefined();
    const anyOrigin = defaultSignals({ sessionCookies: ['session'], csrf: { cookie: 'csrf', header: 'X-CSRF-Token' } });
    expect(anyOrigin.unexpectedSignOut({ url: new URL('https://anywhere.example/'), status: 401 })).toBe(true);
    expect(anyOrigin.csrf).toEqual({ cookie: 'csrf', header: 'X-CSRF-Token' });
    const envelope = defaultSignals({
      apiError: (r) => (((r.json as { status?: number })?.status ?? 200) >= 400 ? 1 : null),
    });
    expect(envelope.apiError({ url: new URL('https://a.example/'), status: 200, json: { status: 500 } })).toBe(1);
  });
});
