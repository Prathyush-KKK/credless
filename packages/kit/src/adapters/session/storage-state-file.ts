// The weaker session provider: a Playwright storage-state file per persona id (`<dir>/<persona>.json`), written by
// some other process. Weaker because the files are long-lived credentials on disk that no run id tags and no
// cleanup revokes; the docs say so. Every cookie value is registered as a secret before it is returned.
import fs from 'node:fs';
import path from 'node:path';
import { registerSecretValue } from '../../core/secret.ts';
import { type BrowserCookie, DEFAULTS, type SessionProvider, type StorageState } from '../../types.ts';

export function storageStateFileSessionProvider(
  options: { dir: string },
  nowSeconds = () => Math.floor(Date.now() / 1000),
): SessionProvider {
  const dir = path.resolve(options.dir);
  return {
    name: 'storage-state-file',
    async mint(persona) {
      const file = path.join(dir, `${persona.id}.json`);
      let state: StorageState;
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8')) as StorageState;
      } catch (error) {
        throw new Error(
          `no storage state for ${persona.id}: ${file} (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
        );
      }
      if (!state || typeof state !== 'object' || !Array.isArray(state.cookies))
        throw new Error(`${file} is not a Playwright storage state (no cookies array)`);
      const cookies = state.cookies as BrowserCookie[];
      for (const cookie of cookies) registerSecretValue(cookie.value);
      for (const origin of state.origins ?? [])
        for (const item of origin.localStorage ?? []) registerSecretValue(item.value);
      const now = nowSeconds();
      const expiries = cookies.map((c) => c.expires).filter((e) => typeof e === 'number' && e > 0);
      const expiresAt = expiries.length ? Math.min(...expiries) : now + DEFAULTS.sessionMaxAgeSeconds;
      if (expiresAt <= now)
        throw new Error(`the storage state for ${persona.id} has expired cookies (${file}); mint it again`);
      return { cookies, storageState: state, expiresAt };
    },
  };
}
