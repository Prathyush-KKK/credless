// Messages a person reads when a command cannot go on, kept in one place so `run`, `health`, `seed` and `doctor` say
// the same thing. Each names what is missing, where it comes from, and the one thing to do next; none ever carries a
// value it was given.
import { CLI_NAME } from '../brand.ts';
import { ENV, type KeySourceRef } from '../types.ts';

/** How to provide the runner key for each kind of key source. */
const KEY_HELP: Record<KeySourceRef['source'], string> = {
  env: `set ${ENV.RUNNER_KEY} in the terminal that runs ${CLI_NAME}, from your secret manager (in CI, from a protected secret)`,
  file: 'create the file the config names, holding only the key, with mode 0600',
  exec: 'install and sign in to the CLI the config names (op, infisical, doppler, vault or kubectl), then try again',
  keyring: 'store the key in the OS keyring under the service and account the config names',
};

/**
 * The runner key could not be read. `reason` is the key source's own message (`no runner key: ... is not set`), which
 * names the variable, the file or the command and never the value.
 */
export function missingKeyMessage(source: KeySourceRef['source'], reason: string): string {
  return `${reason}. To fix: ${KEY_HELP[source]}, or point \`key\` in the config at another source (env, file, exec, keyring). Never paste the key into an agent session; \`${CLI_NAME} doctor\` shows what it finds`;
}
