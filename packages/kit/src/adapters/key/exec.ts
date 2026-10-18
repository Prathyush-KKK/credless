// The `exec` key source: a secret manager's CLI run with `execFile` and an argv array, never a shell, so a reference
// can never become a command. stdout, trimmed, is the key; it is registered as a secret before anything about the
// run is reported, and stderr is redacted before it is quoted.
import { execFile } from 'node:child_process';
import { redact, registerSecretValue, Secret } from '../../core/secret.ts';
import type { ExecPreset, KeySource, KeySourceRef } from '../../types.ts';

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

/**
 * The built-in presets: an argv template per CLI, filled with `ref`. Documented shapes of `ref`:
 * `op`: `op://vault/item/field`; `infisical`: the secret name (environment and path from the CLI's own project
 * config); `doppler`: the secret name; `vault`: `secret/path#field` (field defaults to `value`);
 * `kubectl`: `[namespace/]secret-name#key` (the value is base64 in jsonpath output and decoded here).
 */
export const EXEC_PRESETS: Readonly<Record<ExecPreset, { argv: (ref: string) => string[]; decode?: 'base64' }>> = {
  op: { argv: (ref) => ['op', 'read', '--no-newline', ref] },
  infisical: { argv: (ref) => ['infisical', 'secrets', 'get', ref, '--plain', '--silent'] },
  doppler: { argv: (ref) => ['doppler', 'secrets', 'get', ref, '--plain'] },
  vault: {
    argv: (ref) => {
      const [p, field] = splitRef(ref, 'value');
      return ['vault', 'kv', 'get', `-field=${field}`, p];
    },
  },
  kubectl: {
    argv: (ref) => {
      const [name, key] = splitRef(ref, '');
      if (!key) throw new Error(`kubectl ref must be [namespace/]secret-name#key (got "${ref}")`);
      const slash = name.indexOf('/');
      const namespace = slash > 0 ? ['-n', name.slice(0, slash)] : [];
      const secret = slash > 0 ? name.slice(slash + 1) : name;
      // a key with dots needs escaping in jsonpath
      return ['kubectl', 'get', 'secret', secret, ...namespace, '-o', `jsonpath={.data.${key.replaceAll('.', '\\.')}}`];
    },
    decode: 'base64',
  },
};

function splitRef(ref: string, defaultField: string): [string, string] {
  const hash = ref.lastIndexOf('#');
  return hash > 0 ? [ref.slice(0, hash), ref.slice(hash + 1)] : [ref, defaultField];
}

/** The argv an exec reference runs, for the doctor and for tests; the ref is a locator, not a secret. */
export function execArgv(ref: Extract<KeySourceRef, { source: 'exec' }>): { argv: string[]; decode?: 'base64' } {
  if (ref.argv?.length) return { argv: [...ref.argv] };
  if (!ref.preset || !ref.ref) throw new Error('an exec key source takes either argv, or a preset with its ref');
  const preset = EXEC_PRESETS[ref.preset];
  return { argv: preset.argv(ref.ref), ...(preset.decode ? { decode: preset.decode } : {}) };
}

function run(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) throw new Error('exec key source: empty argv');
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // register what came back before quoting anything: a CLI that printed the value before failing
          registerSecretValue(String(stdout).trim());
          const code = 'code' in error && error.code !== undefined ? ` (${String(error.code)})` : '';
          const detail = redact(String(stderr).split('\n')[0] ?? '').slice(0, 200);
          reject(new Error(`${command} failed${code}${detail ? `: ${detail}` : ''}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function execKeySource(ref: Extract<KeySourceRef, { source: 'exec' }>): KeySource {
  return {
    name: 'exec',
    describe() {
      const { argv } = execArgv(ref);
      return `exec ${argv.join(' ')} (${ref.preset ? `preset ${ref.preset}` : 'argv'}; not run by doctor)`;
    },
    async read() {
      const { argv, decode } = execArgv(ref);
      const { stdout } = await run(argv);
      let value = stdout.trim();
      if (decode === 'base64') value = Buffer.from(value, 'base64').toString('utf8').trim();
      if (!value) throw new Error(`no runner key: ${argv[0]} printed nothing`);
      return new Secret(value, 'runner key');
    },
  };
}
