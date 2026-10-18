// The broker (private B03 and A04): forwards contract routes only, to the API only, with the key added on the far
// side of the worker; the key never appears in any broker answer, and a network failure never quotes it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startBroker } from '../../src/core/broker.ts';
import { mergeRoutes } from '../../src/core/routes.ts';
import { Secret } from '../../src/core/secret.ts';
import { TestApiClient, TestApiError } from '../../src/core/test-api-client.ts';
import { type Broker, CORE_ROUTES, DEFAULTS } from '../../src/types.ts';

const KEY = 'runner-key-value-0123456789-never-printed';
const KEY_HEADER = 'X-Test-Runner-Key';

interface Seen {
  method: string;
  url: string;
  hadKey: boolean;
  headers: Record<string, string | undefined>;
  body: string;
}

const seen: Seen[] = [];
let upstream: http.Server;
let upstreamOrigin: string;
let broker: Broker;
const routes = mergeRoutes(CORE_ROUTES, {
  createWidget: { method: 'POST', path: '/widgets' },
  getWidget: { method: 'GET', path: '/widgets/{id}' },
});

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      hadKey: req.headers[KEY_HEADER.toLowerCase()] === KEY,
      headers: { ...req.headers } as Record<string, string | undefined>,
      body,
    });
    if (req.url === '/_test/session') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': ['sid=upstream-cookie-value-1; Path=/; HttpOnly', 'csrf=upstream-csrf-value-1; Path=/'],
      });
      return res.end(
        JSON.stringify({ user: { userId: 'u1', email: 'qa+a0-owner@example.com', displayName: 'O' }, expiresAt: 1 }),
      );
    }
    if (req.url === '/_test/widgets/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:4319/elsewhere' });
      return res.end();
    }
    if (req.url === '/_test/widgets/missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'not-found', message: 'no such widget' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream-Only': 'yes' });
    res.end(
      JSON.stringify({ ok: true, enabled: true, environment: 'unit', keyId: 'deadbeef', sinks: {}, extensions: [] }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  broker = await startBroker({
    apiOrigin: upstreamOrigin,
    key: new Secret(KEY, 'runner key'),
    keyHeader: KEY_HEADER,
    routes,
    basePath: DEFAULTS.basePath,
    forwardHeaders: ['X-Device-Id', 'Cookie', KEY_HEADER, 'Connection'],
  });
});

afterAll(async () => {
  await broker.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const tokenHeader = () => ({ [DEFAULTS.brokerTokenHeader]: broker.token.reveal() });

async function rawRequest(url: string, requestLine: string, headers: Record<string, string>): Promise<string> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      const lines = [
        requestLine,
        'Host: 127.0.0.1',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Connection: close',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('the broker', () => {
  test('the token is per run, random, and a Secret', () => {
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(String(broker.token)).toBe('broker token=[redacted]');
    expect(broker.token.reveal()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('missing or wrong token: 401 with the contract error shape, nothing forwarded', async () => {
    const before = seen.length;
    const missing = await fetch(`${broker.url}/_test/health`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: 'broker-unauthorized', message: 'broker: missing or wrong token' },
    });
    const wrong = await fetch(`${broker.url}/_test/health`, {
      headers: { [DEFAULTS.brokerTokenHeader]: 'x'.repeat(43) },
    });
    expect(wrong.status).toBe(401);
    const short = await fetch(`${broker.url}/_test/health`, { headers: { [DEFAULTS.brokerTokenHeader]: 'short' } });
    expect(short.status).toBe(401);
    const asKey = await fetch(`${broker.url}/_test/health`, { headers: { [KEY_HEADER]: KEY } });
    expect(asKey.status).toBe(401);
    expect(seen.length).toBe(before);
  });

  test('forwards contract routes only, with the right method, under the base path', async () => {
    const headers = tokenHeader();
    expect((await fetch(`${broker.url}/_test/health`, { headers })).status).toBe(200);
    for (const notContract of [
      '/api/validate-token',
      '/__demo/state',
      '/_test/health/extra',
      '/health',
      '/_test/personas/',
      '/_test/widgets',
      '/_test/widgets/1/2',
    ]) {
      const response = await fetch(`${broker.url}${notContract}`, { headers });
      expect(response.status, notContract).toBe(404);
      expect(await response.json(), notContract).toEqual({
        error: { code: 'broker-not-a-contract-route', message: 'broker: not a contract route' },
      });
    }
    expect((await fetch(`${broker.url}/_test/health`, { method: 'DELETE', headers })).status, 'wrong method').toBe(404);
    expect(
      (await fetch(`${broker.url}/_test/widgets`, { method: 'POST', headers, body: '{}' })).status,
      'extension route',
    ).toBe(200);
    expect((await fetch(`${broker.url}/_test/widgets/42?x=1`, { headers })).status, 'path parameter').toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/_test/widgets/42?x=1', hadKey: true });
  });

  test('path traversal in any spelling and absolute-form targets are refused with 400, never forwarded', async () => {
    const before = seen.length;
    const headers = tokenHeader();
    // fetch() would normalise these before they leave, so they go over a raw socket, as a hostile worker would send them
    for (const bad of [
      '/_test/../_test/health',
      '/_test/%2e%2e/health',
      '/_test/./health',
      '//127.0.0.1:4319/_test/health',
      '/_test/health%5C..',
      '/_test/%ZZ',
    ]) {
      const answer = await rawRequest(broker.url, `GET ${bad} HTTP/1.1`, headers);
      expect(answer, bad).toMatch(/^HTTP\/1\.1 400/);
      expect(answer, bad).not.toContain(KEY);
    }
    expect(await rawRequest(broker.url, 'GET http://127.0.0.1:4319/_test/health HTTP/1.1', headers)).toMatch(
      /^HTTP\/1\.1 400/,
    );
    expect(await rawRequest(broker.url, `GET ${upstreamOrigin}/_test/health HTTP/1.1`, headers)).toMatch(
      /^HTTP\/1\.1 400/,
    );
    expect(seen.length).toBe(before);
  });

  test('adds the key, forwards only listed headers, drops hop-by-hop, cookie and the token; passes Set-Cookie back', async () => {
    const response = await fetch(`${broker.url}/_test/session`, {
      method: 'POST',
      headers: {
        ...tokenHeader(),
        'Content-Type': 'application/json',
        'X-Device-Id': 'dev-1',
        Cookie: 'sid=should-not-pass',
        'X-Not-Listed': 'nope',
        [KEY_HEADER]: 'forged-key-from-a-worker',
      },
      body: JSON.stringify({ handle: 'a0.owner', runId: 'r' }),
    });
    expect(response.status).toBe(200);
    const last = seen.at(-1);
    expect(last).toMatchObject({
      method: 'POST',
      url: '/_test/session',
      hadKey: true,
      body: '{"handle":"a0.owner","runId":"r"}',
    });
    expect(last?.headers['x-device-id']).toBe('dev-1');
    expect(last?.headers['content-type']).toBe('application/json');
    expect(last?.headers.cookie).toBeUndefined();
    expect(last?.headers['x-not-listed']).toBeUndefined();
    expect(last?.headers[DEFAULTS.brokerTokenHeader.toLowerCase()]).toBeUndefined();
    expect(last?.headers[KEY_HEADER.toLowerCase()]).toBe(KEY);
    expect(response.headers.getSetCookie()).toEqual([
      'sid=upstream-cookie-value-1; Path=/; HttpOnly',
      'csrf=upstream-csrf-value-1; Path=/',
    ]);
    expect(response.headers.get('x-upstream-only')).toBeNull();
  });

  test('never follows an upstream redirect; relays upstream errors as they are', async () => {
    const redirect = await fetch(`${broker.url}/_test/widgets/redirect`, {
      headers: tokenHeader(),
      redirect: 'manual',
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBeNull();
    const missing = await fetch(`${broker.url}/_test/widgets/missing`, { headers: tokenHeader() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not-found', message: 'no such widget' } });
  });

  test('a body over the limit is refused', async () => {
    const response = await fetch(`${broker.url}/_test/widgets`, {
      method: 'POST',
      headers: tokenHeader(),
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });

  test('when the test API is down the answer is 502 and still never the key', async () => {
    const down = await startBroker({
      apiOrigin: 'http://127.0.0.1:9',
      key: new Secret(KEY, 'runner key'),
      keyHeader: KEY_HEADER,
      routes,
      basePath: '/_test',
      upstreamTimeoutMs: 2000,
    });
    try {
      const response = await fetch(`${down.url}/_test/health`, {
        headers: { [DEFAULTS.brokerTokenHeader]: down.token.reveal() },
      });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text)).toEqual({
        error: { code: 'broker-upstream-unavailable', message: 'broker: the test API did not answer' },
      });
    } finally {
      await down.close();
    }
  });
});

describe('the client through the broker and directly', () => {
  test('a broker-transport client reaches contract routes and registers cookies; unknown operations fail locally', async () => {
    const api = new TestApiClient({
      apiOrigin: upstreamOrigin,
      transport: { kind: 'broker', url: broker.url, token: broker.token },
      routes,
    });
    const health = await api.call<{ environment: string }>('health');
    expect(health.http).toBe(200);
    expect(health.data.environment).toBe('unit');
    expect(api.log.at(-1)).toMatchObject({ method: 'GET', path: '/_test/health', status: 200 });
    const session = await api.call('createSession', { body: { handle: 'a0.owner', runId: 'r' } });
    expect(session.setCookies).toHaveLength(2);
    const widget = await api.call('getWidget', { params: { id: 'a/b' }, query: { q: 'x', skip: undefined } });
    expect(widget.http).toBe(200);
    expect(seen.at(-1)?.url).toBe('/_test/widgets/a%2Fb?q=x');
    await expect(api.call('nope')).rejects.toThrow(/no test API route nope/);
    const before = seen.length;
    await expect(api.call('createWidget', { params: {}, body: {} })).resolves.toMatchObject({ http: 200 });
    expect(seen.length).toBe(before + 1);
  });

  test('a direct client sends the key header itself; errors carry status and code, never a header', async () => {
    const api = new TestApiClient({
      apiOrigin: upstreamOrigin,
      transport: { kind: 'direct', key: new Secret(KEY, 'runner key') },
      routes,
      headers: { 'X-Device-Id': 'd' },
    });
    await api.call('health');
    expect(seen.at(-1)).toMatchObject({ hadKey: true });
    expect(seen.at(-1)?.headers['x-device-id']).toBe('d');
    const error = await api.call('getWidget', { params: { id: 'missing' } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TestApiError);
    const typed = error as TestApiError;
    expect(typed).toMatchObject({
      name: 'TestApiError',
      operationId: 'getWidget',
      http: 404,
      code: 'not-found',
      notFound: true,
    });
    expect(typed.message).toBe('test API GET /_test/widgets/missing -> HTTP 404 (not-found: no such widget)');
    const redirect = await api.call('getWidget', { params: { id: 'redirect' } }).then(
      () => null,
      (e: unknown) => e as TestApiError,
    );
    expect(redirect?.http).toBe(302);
  });

  test('a network failure never quotes the key or the token (A04)', async () => {
    for (const transport of [
      { kind: 'direct' as const, key: new Secret(KEY, 'runner key') },
      {
        kind: 'broker' as const,
        url: 'http://127.0.0.1:9',
        token: new Secret('broker-token-value-that-must-not-print', 'broker token'),
      },
    ]) {
      const down = new TestApiClient({ apiOrigin: 'http://127.0.0.1:9', transport, timeoutMs: 2000 });
      const error = (await down.call('health').then(
        () => new Error('expected a failure'),
        (e: unknown) => e,
      )) as TestApiError;
      expect(error).toBeInstanceOf(TestApiError);
      expect(error.message).toMatch(/failed before a response/);
      expect(error.http).toBe(0);
      expect(`${error.message}\n${error.stack}`).not.toContain(KEY);
      expect(`${error.message}\n${error.stack}`).not.toContain('broker-token-value');
      expect(down.log[0]).toMatchObject({ method: 'GET', path: '/_test/health', status: 'error' });
    }
  });
});
