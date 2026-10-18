// Session providers (plan §4.2): how a persona's browser gets signed in.
import type { SessionProvider, SessionProviderRef } from '../../types.ts';
import { storageStateFileSessionProvider } from './storage-state-file.ts';
import { type TestApiSessionOptions, testApiSessionProvider } from './test-api.ts';

export type { TestApiSessionOptions };
export { storageStateFileSessionProvider, testApiSessionProvider };

/** The built-in session provider for a config reference (`test-api`, `storage-state-file`); `module` needs {@link loadSessionProvider}. */
export function sessionProvider(ref: SessionProviderRef, options: TestApiSessionOptions = {}): SessionProvider {
  switch (ref.provider) {
    case 'test-api':
      return testApiSessionProvider(options);
    case 'storage-state-file':
      return storageStateFileSessionProvider({ dir: ref.dir });
    case 'module':
      throw new Error(`session provider module ${ref.module} must be loaded with loadSessionProvider()`);
    default:
      throw new Error(`unknown session provider ${String((ref as { provider?: unknown }).provider)}`);
  }
}

/** Like {@link sessionProvider}, and loads a `module` reference (default export: a SessionProvider). */
export async function loadSessionProvider(
  ref: SessionProviderRef,
  options: TestApiSessionOptions = {},
): Promise<SessionProvider> {
  if (ref.provider !== 'module') return sessionProvider(ref, options);
  const loaded = (await import(ref.module)) as { default?: unknown };
  const provider = loaded.default as SessionProvider | undefined;
  if (!provider || typeof provider.mint !== 'function')
    throw new Error(`${ref.module} does not export a SessionProvider as default`);
  return provider;
}

/** The stub's name for {@link sessionProvider}. */
export const createSessionProvider = sessionProvider;
