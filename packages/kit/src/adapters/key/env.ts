// The `env` key source: the key in an environment variable (CI passes it to the one `run` step). Reading it takes it
// over: the variable is deleted from this process's environment, so nothing spawned later inherits it.
import { Secret } from '../../core/secret.ts';
import { ENV, type KeySource, type KeySourceRef } from '../../types.ts';

export function envKeySource(
  ref: Extract<KeySourceRef, { source: 'env' }>,
  env: NodeJS.ProcessEnv = process.env,
): KeySource {
  const name = ref.name ?? ENV.RUNNER_KEY;
  return {
    name: 'env',
    describe() {
      // presence only: `in` never reads the value
      return `env ${name} (${name in env ? 'set' : 'not set'})`;
    },
    async read() {
      const raw = env[name];
      delete env[name];
      const value = raw?.trim() ?? '';
      if (!value) throw new Error(`no runner key: ${name} is not set`);
      return new Secret(value, 'runner key');
    },
  };
}
