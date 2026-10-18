// The default session provider: `POST /session` through the test API, the backend's own login seam, so the cookies
// are exactly those a web login sets.
import { mintSession } from '../../core/session.ts';
import type { SessionProvider } from '../../types.ts';

export interface TestApiSessionOptions {
  /** `AppSignals.sessionCookies`: each must be set and HttpOnly; default: any cookie */
  sessionCookies?: string[];
  /** contract `CreateSessionRequest.client` (default `web`) */
  client?: string;
}

export function testApiSessionProvider(options: TestApiSessionOptions = {}): SessionProvider {
  return {
    name: 'test-api',
    mint(persona, ctx) {
      return mintSession(ctx.api, {
        handle: persona.handle,
        runId: ctx.runId,
        ...(options.client ? { client: options.client } : {}),
        ...(options.sessionCookies ? { sessionCookies: options.sessionCookies } : {}),
      });
    },
  };
}
