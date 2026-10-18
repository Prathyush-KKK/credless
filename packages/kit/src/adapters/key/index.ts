// Key sources (plan §4.2): where the runner key comes from. `describe()` never runs anything and never reads a
// value; `read()` is called by `run` once, in the CLI's own process.
import type { KeySource, KeySourceRef } from '../../types.ts';
import { envKeySource } from './env.ts';
import { EXEC_PRESETS, execArgv, execKeySource } from './exec.ts';
import { fileKeySource } from './file.ts';
import { keyringKeySource } from './keyring.ts';

export { EXEC_PRESETS, envKeySource, execArgv, execKeySource, fileKeySource, keyringKeySource };

/** The built-in key source for a config reference (`env`, `file`, `exec`, `keyring`). */
export function keySource(ref: KeySourceRef): KeySource {
  switch (ref.source) {
    case 'env':
      return envKeySource(ref);
    case 'file':
      return fileKeySource(ref);
    case 'exec':
      return execKeySource(ref);
    case 'keyring':
      return keyringKeySource(ref);
    default:
      throw new Error(`unknown key source ${String((ref as { source?: unknown }).source)}`);
  }
}

/** The stub's name for {@link keySource}. */
export const createKeySource = keySource;
