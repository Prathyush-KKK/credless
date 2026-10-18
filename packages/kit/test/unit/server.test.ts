// `createTestApi` against the contract, in process: the key check, the refusals, the seven routes over a fake store,
// Set-Cookie on /session, and the extension hook.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestApi, Reply, refuse, type TestApiServer } from '../../src/server/index.ts';
import type { PersonaState, TestApiServerOptions } from '../../src/types.ts';

const KEY = 'unit-test-key-0123456789abcdef';
const RUN = '20261018T101500Z-ab12';

function fakeStore() {
  const accounts = new Map<string, PersonaState & { test: boolean }>([
    ['a9.real', { handle: 'a9.real', userId: 'u_real', state: {}, test: false }],
  ]);
  const sessions: Array<{ handle: string; runId: string }> = [];
  const calls: string[] = [];
  const options: TestApiServerOptions = {
    key: KEY,
    environment: 'unit',
    version: '1',
    sinks: { mail: true },
    extensions: ['listed'],
    addressPattern: /^qa\+[a-z0-9-]+@example\.com$/,
    personas: {
      async ensure(specs) {
        return specs.map((s) => {
          const created = !accounts.has(s.handle);
          if (created)
            accounts.set(s.handle, {
              handle: s.handle,
              userId: `u_${s.handle}`,
              state: { role: s.attributes.role },
              test: true,
            });
          return { handle: s.handle, userId: `u_${s.handle}`, created };
        });
      },
      async reset(handles) {
        calls.push(`reset ${handles.join(',')}`);
        return handles.map((handle) => ({ handle, removed: { things: 1 } }));
      },
      async state(handle) {
        const a = accounts.get(handle);
        return a ? { handle: a.handle, userId: a.userId, state: a.state } : null;
      },
    },
    session: {
      async mint(request) {
        sessions.push({ handle: request.handle, runId: request.runId });
        calls.push(`mint ${request.handle} ${request.client}`);
        return {
          setCookies: [
            'sid=abc; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
            'csrf=def; Path=/; Max-Age=3600; SameSite=Lax',
          ],
          user: { userId: `u_${request.handle}`, email: 'qa+a0-owner@example.com', displayName: 'Ada QA-a0' },
          expiresAt: 1_800_000_000,
        };
      },
      async revoke(runId) {
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i -= 1) if (sessions[i]?.runId === runId) sessions.splice(i, 1);
        return before - sessions.length;
      },
    },
    mail: {
      async list(handle, query) {
        calls.push(`mail ${handle} ${JSON.stringify(query)}`);
        return [{ id: 'm1', to: 'x', subject: 's', sentAt: 1, links: [], codes: ['123456'], kind: 'invite' }];
      },
    },
    async cleanup(runId) {
      calls.push(`cleanup ${runId}`);
      return { things: 2 };
    },
    isTestAccount: async (handle) => accounts.get(handle)?.test ?? false,
  };
  return { options, calls, sessions };
}

describe('createTestApi', () => {
  let server: http.Server;
  let origin = '';
  let api: TestApiServer;
  const store = fakeStore();
  let appHits = 0;

  beforeAll(async () => {
    api = createTestApi(store.options).extend([
      {
        operationId: 'ping',
        method: 'GET',
        path: '/ping/{what}',
        handler: ({ params, keyId }) => ({ pong: params.what, keyId }),
      },
      {
        operationId: 'teapot',
        method: 'POST',
        path: '/teapot',
        handler: () => new Reply(418, { short: true }, { 'X-Pot': 'short' }),
      },
      { operationId: 'refused', method: 'GET', path: '/refused', handler: () => refuse(409, 'conflict', 'no') },
      {
        operationId: 'broken',
        method: 'GET',
        path: '/broken',
        handler: () => {
          throw new Error('secret-ish detail that must not leak');
        },
      },
    ]);
    server = http.createServer(async (req, res) => {
      if (await api(req, res)) return;
      appHits += 1;
      res.writeHead(404).end('app');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const call = (path: string, init: RequestInit = {}, key: string | null = KEY) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'X-Test-Runner-Key': key } : {}),
        ...(init.headers ?? {}),
      },
    });
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

  test('outside the base path it answers false and the app takes over', async () => {
    const before = appHits;
    expect((await fetch(`${origin}/_tes/health`)).status).toBe(404);
    expect((await fetch(`${origin}/_testing`)).status).toBe(404);
    expect(appHits).toBe(before + 2);
  });

  test('the key: 401 when missing or wrong, before any route lookup; keyId is 8 hex of the presented key', async () => {
    expect(await json(await call('/_test/health', {}, null))).toMatchObject({
      status: 401,
      body: { error: { code: 'bad-key' } },
    });
    expect(await json(await call('/_test/health', {}, 'wrong'))).toMatchObject({
      status: 401,
      body: { error: { code: 'bad-key' } },
    });
    expect(await json(await call('/_test/nothing-here', {}, null))).toMatchObject({ status: 401 });
    expect(await json(await call('/_test/nothing-here'))).toMatchObject({
      status: 404,
      body: { error: { code: 'not-found' } },
    });
    const health = await json(await call('/_test/health'));
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ enabled: true, environment: 'unit', version: '1', sinks: { mail: true } });
    expect(health.body.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(health.body.extensions).toEqual(['listed', 'ping', 'teapot', 'refused', 'broken']);
    expect(Object.keys(api.routes)).toContain('ping');
    expect(api.routes.ping).toEqual({ method: 'GET', path: '/ping/{what}' });
  });

  test('ensure: 422 on a bad spec, 403 outside the address range, else created flags', async () => {
    const spec = (handle: string, email: string) => ({
      handle,
      email,
      displayName: 'Ada QA-a0',
      attributes: { role: 'owner' },
    });
    expect((await json(await call('/_test/personas/ensure', { method: 'POST', body: '{"personas":[]}' }))).status).toBe(
      422,
    );
    expect((await json(await call('/_test/personas/ensure', { method: 'POST', body: 'not json' }))).status).toBe(422);
    expect(
      (
        await json(
          await call('/_test/personas/ensure', {
            method: 'POST',
            body: JSON.stringify({ personas: [spec('bad handle', 'qa+a0-x@example.com')] }),
          }),
        )
      ).status,
    ).toBe(422);
    const outside = await json(
      await call('/_test/personas/ensure', {
        method: 'POST',
        body: JSON.stringify({ personas: [spec('a0.x', 'someone@example.net')] }),
      }),
    );
    expect(outside).toMatchObject({ status: 403, body: { error: { code: 'address-outside-range' } } });
    const ok = await json(
      await call('/_test/personas/ensure', {
        method: 'POST',
        body: JSON.stringify({ personas: [spec('a0.owner', 'qa+a0-owner@example.com')] }),
      }),
    );
    expect(ok).toMatchObject({
      status: 200,
      body: { personas: [{ handle: 'a0.owner', userId: 'u_a0.owner', created: true }] },
    });
    const again = await json(
      await call('/_test/personas/ensure', {
        method: 'POST',
        body: JSON.stringify({ personas: [spec('a0.owner', 'qa+a0-owner@example.com')] }),
      }),
    );
    expect(again.body).toMatchObject({ personas: [{ created: false }] });
  });

  test('state and reset: 404 unknown, 403 not a test account (lock 4), 200 otherwise', async () => {
    expect(await json(await call('/_test/personas/z9.nobody'))).toMatchObject({
      status: 404,
      body: { error: { code: 'not-found' } },
    });
    expect(await json(await call('/_test/personas/a9.real'))).toMatchObject({
      status: 403,
      body: { error: { code: 'not-test-account' } },
    });
    expect(await json(await call('/_test/personas/a0.owner'))).toMatchObject({
      status: 200,
      body: { handle: 'a0.owner', state: { role: 'owner' } },
    });
    expect(
      (
        await json(
          await call('/_test/personas/reset', { method: 'POST', body: JSON.stringify({ handles: ['a9.real'] }) }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await json(await call('/_test/personas/reset', { method: 'POST', body: JSON.stringify({ handles: [] }) })))
        .status,
    ).toBe(422);
    const reset = await json(
      await call('/_test/personas/reset', { method: 'POST', body: JSON.stringify({ handles: ['a0.owner'] }) }),
    );
    expect(reset).toMatchObject({ status: 200, body: { reset: [{ handle: 'a0.owner', removed: { things: 1 } }] } });
  });

  test('session: the store cookies ride in Set-Cookie, the body has user and expiresAt, 422 without a run id', async () => {
    const res = await call('/_test/session', {
      method: 'POST',
      body: JSON.stringify({ handle: 'a0.owner', runId: RUN }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      'sid=abc; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
      'csrf=def; Path=/; Max-Age=3600; SameSite=Lax',
    ]);
    expect(await res.json()).toEqual({
      user: { userId: 'u_a0.owner', email: 'qa+a0-owner@example.com', displayName: 'Ada QA-a0' },
      expiresAt: 1_800_000_000,
    });
    expect(store.calls).toContain('mint a0.owner web');
    expect(
      (await call('/_test/session', { method: 'POST', body: JSON.stringify({ handle: 'a0.owner' }) })).status,
    ).toBe(422);
    expect(
      (
        await call('/_test/session', {
          method: 'POST',
          body: JSON.stringify({ handle: 'a0.owner', runId: RUN, client: 1 }),
        })
      ).status,
    ).toBe(422);
    expect(
      (await call('/_test/session', { method: 'POST', body: JSON.stringify({ handle: 'a9.real', runId: RUN }) }))
        .status,
    ).toBe(403);
  });

  test('messages: the query is validated and passed through; codes travel as plain strings', async () => {
    expect((await call('/_test/personas/a0.owner/messages?limit=0')).status).toBe(422);
    expect((await call('/_test/personas/a0.owner/messages?since=-1')).status).toBe(422);
    expect((await call('/_test/personas/a9.real/messages')).status).toBe(403);
    const res = await json(await call('/_test/personas/a0.owner/messages?kind=invite&since=5&limit=2'));
    expect(res.body).toEqual({
      messages: [{ id: 'm1', to: 'x', subject: 's', sentAt: 1, links: [], codes: ['123456'], kind: 'invite' }],
    });
    expect(store.calls).toContain('mail a0.owner {"since":5,"kind":"invite","limit":2}');
  });

  test('cleanup: removes by run id and revokes its sessions unless told not to; 422 on a bad run id', async () => {
    expect((await call('/_test/runs/not-a-run/cleanup', { method: 'POST' })).status).toBe(422);
    const kept = await json(
      await call(`/_test/runs/${RUN}/cleanup`, { method: 'POST', body: JSON.stringify({ revokeSessions: false }) }),
    );
    expect(kept.body).toEqual({ removed: { things: 2 }, sessionsRevoked: 0 });
    const revoked = await json(await call(`/_test/runs/${RUN}/cleanup`, { method: 'POST' }));
    expect(revoked.body).toEqual({ removed: { things: 2 }, sessionsRevoked: 1 });
    expect(
      (await call(`/_test/runs/${RUN}/cleanup`, { method: 'POST', body: JSON.stringify({ revokeSessions: 'yes' }) }))
        .status,
    ).toBe(422);
  });

  test('extensions: params and keyId, a Reply with status and headers, a Refusal, and a crash kept generic', async () => {
    const ping = await json(await call('/_test/ping/there'));
    expect(ping.status).toBe(200);
    expect(ping.body.pong).toBe('there');
    expect(ping.body.keyId).toMatch(/^[0-9a-f]{8}$/);
    const pot = await call('/_test/teapot', { method: 'POST' });
    expect(pot.status).toBe(418);
    expect(pot.headers.get('x-pot')).toBe('short');
    expect(await json(await call('/_test/refused'))).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'no' } },
    });
    const broken = await json(await call('/_test/broken'));
    expect(broken.status).toBe(500);
    expect(JSON.stringify(broken.body)).not.toContain('secret-ish');
    expect((await call('/_test/teapot', { method: 'GET' })).status).toBe(404); // the method is part of the route
  });
});
