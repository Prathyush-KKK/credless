// Stand-in for src/adapters/key/index.ts (Task 1), with the frozen signature `createKeySource(ref)` of
// src/adapters/index.ts. `describe()` reports presence only; `read()` is the one place a value is read.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { ENV, type ExecPreset, type KeySource, type KeySourceRef } from '../../types.ts';
import { Secret } from './secret.ts';

const execFileAsync = promisify(execFile);

/** The argv each preset runs (no shell); `ref` is the one argument a person supplies. */
export const EXEC_PRESETS: Record<ExecPreset, (ref: string) => string[]> = {
  op: (ref) => ['op', 'read', ref],
  infisical: (ref) => ['infisical', 'secrets', 'get', ref, '--plain', '--silent'],
  doppler: (ref) => ['doppler', 'secrets', 'get', ref, '--plain'],
  vault: (ref) => ['vault', 'kv', 'get', '-field=value', ref],
  kubectl: (ref) => ['kubectl', 'get', 'secret', ref, '-o', 'jsonpath={.data.key}'],
};

/** The argv an `exec` reference runs. Throws when the reference names neither argv nor a preset. */
export function execArgv(ref: Extract<KeySourceRef, { source: 'exec' }>): string[] {
  if (ref.argv?.length) return ref.argv;
  if (ref.preset && ref.ref) return EXEC_PRESETS[ref.preset](ref.ref);
  throw new Error('exec key source needs argv, or preset and ref');
}

export function createKeySource(ref: KeySourceRef): KeySource {
  switch (ref.source) {
    case 'env': {
      const name = ref.name ?? ENV.RUNNER_KEY;
      return {
        name: 'env',
        describe: () => `env ${name} (${process.env[name] ? 'set' : 'not set'})`,
        read: async () => {
          const value = process.env[name]?.trim();
          delete process.env[name];
          if (!value) throw new Error(`${name} is not set`);
          return new Secret(value, 'runner key');
        },
      };
    }
    case 'file':
      return {
        name: 'file',
        describe: () => `file ${ref.path} (${fs.existsSync(ref.path) ? 'present' : 'missing'})`,
        read: async () => {
          const value = fs.readFileSync(ref.path, 'utf8').trim();
          if (!value) throw new Error(`${ref.path} is empty`);
          return new Secret(value, 'runner key');
        },
      };
    case 'exec': {
      const argv = execArgv(ref);
      return {
        name: 'exec',
        describe: () => `exec ${argv[0]} (${argv.length - 1} argument${argv.length === 2 ? '' : 's'})`,
        read: async () => {
          const [cmd, ...args] = argv;
          const { stdout } = await execFileAsync(cmd as string, args, { encoding: 'utf8', timeout: 60_000 });
          const value = stdout.trim();
          if (!value) throw new Error(`${cmd} printed nothing`);
          return new Secret(value, 'runner key');
        },
      };
    }
    case 'keyring':
      return {
        name: 'keyring',
        describe: () => `keyring ${ref.service}/${ref.account} (@napi-rs/keyring)`,
        read: async () => {
          throw new Error('keyring key source: stand-in; Task 1 implements it behind the optional dependency');
        },
      };
  }
}
