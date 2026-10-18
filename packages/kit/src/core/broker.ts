// The run's loopback broker: the only place in a test run that holds the runner key.
//
// Global setup (the runner's main process) starts it on 127.0.0.1, hands the workers its URL and a random per-run
// token, and removes the key from the environment the workers and browsers inherit. Workers call the broker; the
// broker adds the key and forwards contract routes only (core plus the app's), never following redirects. It logs
// nothing. When the run ends it closes, and the token is worthless.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Broker, type BrokerOptions, DEFAULTS } from '../types.ts';
import { routeMatcher } from './routes.ts';
import { Secret, timingSafeEqualString } from './secret.ts';

const MAX_BODY = 1024 * 1024;

// Never forwarded whatever the allowlist says: hop-by-hop headers, and anything that would carry a credential past
// the broker (a worker has no credential to carry; the key is added here).
const NEVER_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'authorization',
  DEFAULTS.brokerTokenHeader.toLowerCase(),
]);

const DEFAULT_FORWARDED = ['accept', 'content-type', 'accept-language'];

export interface StartBrokerOptions extends Omit<BrokerOptions, 'forwardHeaders'> {
  /** default: content negotiation only; add the names of `testApi.headers` for a backend that filters on them */
  forwardHeaders?: string[];
}

function reply(res: http.ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

/** An origin-form request target: a path, never a scheme or an authority, never a `..` segment in any spelling. */
function isSafeTarget(rawUrl: string): boolean {
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return false;
  const path = rawUrl.split('?')[0] ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.includes('\\')) return false;
  return !decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

/** Start the broker on an ephemeral loopback port. `routes` is the allowlist (core plus the app's extension). */
export async function startBroker(options: StartBrokerOptions): Promise<Broker> {
  const apiOrigin = new URL(options.apiOrigin).origin;
  const keyHeader = options.keyHeader;
  const matcher = routeMatcher(options.routes, options.basePath);
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 150_000;
  const forwarded = [
    ...new Set([...DEFAULT_FORWARDED, ...(options.forwardHeaders ?? [])].map((h) => h.toLowerCase())),
  ].filter((h) => !NEVER_FORWARDED.has(h) && h !== keyHeader.toLowerCase());
  const token = new Secret(crypto.randomBytes(32).toString('base64url'), 'broker token');
  const expected = token.reveal();

  const server = http.createServer(async (req, res) => {
    try {
      const given = req.headers[DEFAULTS.brokerTokenHeader.toLowerCase()];
      if (typeof given !== 'string' || !timingSafeEqualString(given, expected)) {
        return reply(res, 401, 'broker-unauthorized', 'broker: missing or wrong token');
      }
      const rawUrl = req.url ?? '';
      if (!isSafeTarget(rawUrl)) return reply(res, 400, 'broker-bad-path', 'broker: bad request target');
      const target = new URL(rawUrl, apiOrigin);
      if (target.origin !== apiOrigin) return reply(res, 400, 'broker-bad-path', 'broker: bad request target');
      const method = req.method ?? 'GET';
      if (!matcher.match(method, target.pathname))
        return reply(res, 404, 'broker-not-a-contract-route', 'broker: not a contract route');

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return reply(res, 413, 'broker-body-too-large', 'broker: body too large');
        chunks.push(chunk as Buffer);
      }
      const headers: Record<string, string> = {};
      for (const name of forwarded) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      headers[keyHeader] = options.key.reveal();

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
      } catch {
        // the cause could quote the request (and its headers): never forwarded, never logged
        return reply(res, 502, 'broker-upstream-unavailable', 'broker: the test API did not answer');
      }
      const out: Record<string, string | string[]> = {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      };
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) out['Set-Cookie'] = cookies;
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      if (!res.headersSent) reply(res, 500, 'broker-error', 'broker: internal error');
      else res.end();
    }
  });
  server.requestTimeout = upstreamTimeoutMs + 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
