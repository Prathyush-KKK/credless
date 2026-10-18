// Signed-in sessions for personas, from `POST /session`. The backend answers with the same Set-Cookie a web login
// sends; those cookies go straight into the persona's browser context and nowhere else. The app boots signed in,
// exactly as after a real sign-in, so no app storage is touched.
import type { BrowserCookie, CreateSessionResponse, SessionGrant, TestApiClient } from '../types.ts';
import { TestApiError } from './test-api-client.ts';

/** RFC 6265 default-path: the request path up to (not including) its last slash. */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const last = requestPath.lastIndexOf('/');
  return last <= 0 ? '/' : requestPath.slice(0, last);
}

/** One Set-Cookie header value as the browser would store it, for a response from `requestUrl`. */
export function parseSetCookie(
  header: string,
  requestUrl: URL,
  nowSeconds = Math.floor(Date.now() / 1000),
): BrowserCookie {
  const [pair = '', ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new Error('malformed Set-Cookie (no name)');
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const host = requestUrl.hostname.toLowerCase();

  let domain = host;
  let hostOnly = true;
  let path = defaultPath(requestUrl.pathname);
  let expires = -1;
  let maxAgeSeen = false;
  let httpOnly = false;
  let secure = false;
  let sameSite: BrowserCookie['sameSite'] = 'Lax';

  for (const raw of attributes) {
    const [k = '', ...rest] = raw.split('=');
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    switch (key) {
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (!d) break;
        if (host !== d && !host.endsWith(`.${d}`))
          throw new Error(`Set-Cookie ${name}: domain ${d} does not match ${host}`);
        domain = d;
        hostOnly = false;
        break;
      }
      case 'path':
        if (val.startsWith('/')) path = val;
        break;
      case 'max-age': {
        const seconds = Number.parseInt(val, 10);
        if (Number.isFinite(seconds)) {
          expires = seconds <= 0 ? 0 : nowSeconds + seconds;
          maxAgeSeen = true;
        }
        break;
      }
      case 'expires': {
        if (maxAgeSeen) break; // Max-Age wins
        const at = Date.parse(val);
        if (Number.isFinite(at)) expires = Math.floor(at / 1000);
        break;
      }
      case 'httponly':
        httpOnly = true;
        break;
      case 'secure':
        secure = true;
        break;
      case 'samesite': {
        const v = val.toLowerCase();
        sameSite = v === 'strict' ? 'Strict' : v === 'none' ? 'None' : 'Lax';
        break;
      }
      default:
        break;
    }
  }
  return { name, value, domain: hostOnly ? domain : `.${domain}`, path, expires, httpOnly, secure, sameSite };
}

/**
 * The cookies as the persona's browser gets them: a cookie scoped to a whole domain (`Domain=.example.com`) becomes
 * host-only copies on the run's own hosts, so the browser never sends a session to any other host of the domain
 * (production included), even after a redirect. A cookie that matches none of the hosts is dropped.
 */
export function narrowCookies(cookies: BrowserCookie[], hosts: string[]): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const cookie of cookies) {
    if (!cookie.domain.startsWith('.')) {
      if (hosts.includes(cookie.domain)) out.push(cookie);
      continue;
    }
    const domain = cookie.domain.slice(1);
    for (const host of hosts) if (host === domain || host.endsWith(`.${domain}`)) out.push({ ...cookie, domain: host });
  }
  return out;
}

export interface MintSessionOptions {
  handle: string;
  runId: string;
  /** which client the session is for (contract `CreateSessionRequest.client`, default `web`) */
  client?: string;
  /** `AppSignals.sessionCookies`: each must be set and HttpOnly, as a real login sets it; omitted: any cookie will do */
  sessionCookies?: string[];
  /** injected in tests */
  nowSeconds?: number;
}

/** Ask the backend to sign `handle` in; returns the cookies for its browser context. */
export async function mintSession(api: TestApiClient, options: MintSessionOptions): Promise<SessionGrant> {
  const { handle, runId, client = 'web', sessionCookies = [] } = options;
  const result = await api.call<CreateSessionResponse>('createSession', { body: { handle, runId, client } });
  const route = api.routes.createSession;
  const requestUrl = new URL(`${api.basePath}${route?.path ?? '/session'}`, api.apiOrigin);
  const cookies = result.setCookies.map((h) => parseSetCookie(h, requestUrl, options.nowSeconds));
  const refuse = (why: string) =>
    new TestApiError('createSession', result.http, null, `test API session for ${handle} ${why}`);
  if (cookies.length === 0) throw refuse('set no cookie');
  for (const name of sessionCookies) {
    const cookie = cookies.find((c) => c.name === name);
    if (!cookie?.value) throw refuse(`set no ${name} cookie`);
    if (!cookie.httpOnly) throw refuse(`: ${name} is not HttpOnly (a real login sets HttpOnly)`);
  }
  const body = result.data;
  if (!body || typeof body !== 'object' || typeof body.expiresAt !== 'number')
    throw refuse('answered without expiresAt');
  return { cookies, expiresAt: body.expiresAt, ...(body.user ? { user: body.user } : {}) };
}
