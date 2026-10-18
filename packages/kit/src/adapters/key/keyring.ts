// The `keyring` key source: the OS keyring through `@napi-rs/keyring`, an optional dependency. `describe()` says
// whether the module is installed without loading it; `read()` loads it on demand.
import { Secret } from '../../core/secret.ts';
import type { KeySource, KeySourceRef } from '../../types.ts';

const MODULE = '@napi-rs/keyring';

interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): string | null;
  };
}

function installed(): boolean {
  try {
    import.meta.resolve(MODULE);
    return true;
  } catch {
    return false;
  }
}

export function keyringKeySource(
  ref: Extract<KeySourceRef, { source: 'keyring' }>,
  importer: (name: string) => Promise<unknown> = (name) => import(name),
): KeySource {
  return {
    name: 'keyring',
    describe() {
      return `keyring ${ref.service}/${ref.account} (${installed() ? `${MODULE} installed` : `${MODULE} is not installed: add the optional dependency`})`;
    },
    async read() {
      let mod: KeyringModule;
      try {
        mod = (await importer(MODULE)) as KeyringModule;
      } catch {
        throw new Error(
          `no runner key: ${MODULE} is not installed (the keyring key source needs the optional dependency)`,
        );
      }
      const value = new mod.Entry(ref.service, ref.account).getPassword()?.trim() ?? '';
      if (!value) throw new Error(`no runner key: the keyring has no entry ${ref.service}/${ref.account}`);
      return new Secret(value, 'runner key');
    },
  };
}
