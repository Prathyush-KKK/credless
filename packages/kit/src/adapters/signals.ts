// How the app signals things the kit must recognise (plan §4.2): sign-outs and API errors. The defaults suit an
// app whose API uses HTTP status codes; an app that wraps errors in an envelope with HTTP 200 overrides both rules.
import { addRedactionCookies, addRedactionHeaders } from '../core/secret.ts';
import type { AppSignals } from '../types.ts';

export interface SignalsContext {
  /** the api origin a 401 counts on; without it any 401 is a sign-out */
  apiOrigin?: string;
}

/**
 * The default signals with the config's overrides: `sessionCookies` `['sid']`, `unexpectedSignOut` a 401 on the api
 * origin, `apiError` any status >= 400. The session cookie names and the CSRF header are told to the redactor.
 */
export function defaultSignals(partial: Partial<AppSignals> = {}, context: SignalsContext = {}): AppSignals {
  const apiOrigin = context.apiOrigin ? new URL(context.apiOrigin).origin : undefined;
  const signals: AppSignals = {
    sessionCookies: partial.sessionCookies ?? ['sid'],
    unexpectedSignOut:
      partial.unexpectedSignOut ?? ((r) => r.status === 401 && (apiOrigin === undefined || r.url.origin === apiOrigin)),
    apiError: partial.apiError ?? ((r) => (r.status >= 400 ? r.status : null)),
    ...(partial.csrf ? { csrf: partial.csrf } : {}),
    ...(partial.bootCover ? { bootCover: partial.bootCover } : {}),
  };
  addRedactionCookies(...signals.sessionCookies);
  if (signals.csrf) {
    addRedactionCookies(signals.csrf.cookie);
    addRedactionHeaders(signals.csrf.header);
  }
  return signals;
}

/** The stub's name for {@link defaultSignals}. */
export const resolveSignals = defaultSignals;
