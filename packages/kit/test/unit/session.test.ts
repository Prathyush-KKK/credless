// Set-Cookie as the browser stores it (private U09–U10), host-only narrowing, and minting through the client.
import { describe, expect, test } from 'vitest';
import { registeredSecretCount } from '../../src/core/secret.ts';
import { mintSession, narrowCookies, parseSetCookie } from '../../src/core/session.ts';
import type { BrowserCookie, CallRequest, CallResult, TestApiClient } from '../../src/types.ts';
import { CORE_ROUTES } from '../../src/types.ts';

const url = new URL('https://dev-api.example.com/_test/session');
const now = 1_800_000_000;

describe('parseSetCookie', () => {
  test('a host-only session cookie with Max-Age', () => {
    const c = parseSetCookie('sid=abc.def.ghi; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax', url, now);
    expect(c).toEqual({
      name: 'sid',
      value: 'abc.def.ghi',
      domain: 'dev-api.example.com',
      path: '/',
      expires: now + 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  });

  test('a Domain cookie, Max-Age over Expires, the default path, SameSite, and bad domains', () => {
    const c = parseSetCookie(
      'csrf=x=y; Domain=.example.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=60; SameSite=Strict',
      url,
      now,
    );
    expect(c.domain).toBe('.example.com');
    expect(c.value).toBe('x=y');
    expect(c.expires).toBe(now + 60);
    expect(c.path).toBe('/_test');
    expect(c.sameSite).toBe('Strict');
    expect(c.httpOnly).toBe(false);
    expect(c.secure).toBe(false);
    expect(parseSetCookie('a=b; Expires=Wed, 01 Jan 2031 00:00:00 GMT', url, now).expires).toBe(
      Math.floor(Date.parse('2031-01-01T00:00:00Z') / 1000),
    );
    expect(parseSetCookie('a=b; Domain=example.com', url, now).domain).toBe('.example.com');
    expect(parseSetCookie('a=b; Domain=DEV-API.example.com', url, now).domain).toBe('.dev-api.example.com');
    expect(() => parseSetCookie('a=b; Domain=other.example', url, now)).toThrow(/does not match/);
    expect(parseSetCookie('a=b; Max-Age=0', url, now).expires).toBe(0);
    expect(parseSetCookie('a=b; Max-Age=-5', url, now).expires).toBe(0);
    expect(parseSetCookie('a=b', url, now).expires).toBe(-1);
    expect(parseSetCookie('a=b; SameSite=None; Secure', url, now).sameSite).toBe('None');
    expect(parseSetCookie('a=b; SameSite=weird', url, now).sameSite).toBe('Lax');
    expect(parseSetCookie('a=b; Path=relative', url, now).path).toBe('/_test');
    expect(parseSetCookie('a=b', new URL('https://h.example/'), now).path).toBe('/');
    expect(() => parseSetCookie('=b', url, now)).toThrow(/no name/);
    expect(() => parseSetCookie('nonsense', url, now)).toThrow(/no name/);
  });
});

describe('narrowCookies', () => {
  const cookie = (over: Partial<BrowserCookie>): BrowserCookie => ({
    name: 'sid',
    value: 'v',
    domain: 'dev-api.example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...over,
  });

  test('a domain cookie becomes host-only copies on the run hosts; nothing else survives', () => {
    const hosts = ['dev.example.com', 'dev-api.example.com'];
    const out = narrowCookies([cookie({ domain: '.example.com' })], hosts);
    expect(out.map((c) => c.domain)).toEqual(hosts);
    expect(out.every((c) => !c.domain.startsWith('.'))).toBe(true);
    expect(narrowCookies([cookie({ domain: '.other.example' })], hosts)).toEqual([]);
    expect(narrowCookies([cookie({ domain: 'dev-api.example.com' })], hosts)).toEqual([
      cookie({ domain: 'dev-api.example.com' }),
    ]);
    expect(narrowCookies([cookie({ domain: 'www.example.com' })], hosts)).toEqual([]);
    expect(narrowCookies([cookie({ domain: '.dev-api.example.com' })], hosts).map((c) => c.domain)).toEqual([
      'dev-api.example.com',
    ]);
  });
});

function fakeClient(
  answer: (operationId: string, request: CallRequest) => CallResult<unknown>,
): TestApiClient & { calls: Array<{ operationId: string; request: CallRequest }> } {
  const calls: Array<{ operationId: string; request: CallRequest }> = [];
  return {
    apiOrigin: 'https://dev-api.example.com',
    basePath: '/_test',
    routes: CORE_ROUTES,
    log: [],
    calls,
    async call<T>(operationId: string, request: CallRequest = {}) {
      calls.push({ operationId, request });
      return answer(operationId, request) as CallResult<T>;
    },
  };
}

describe('mintSession', () => {
  const body = {
    user: { userId: 'u_8f3a', email: 'qa+a0-owner@example.com', displayName: 'Olive QA-a0' },
    expiresAt: now + 3600,
  };

  test('sends the contract request and turns Set-Cookie into browser cookies', async () => {
    const api = fakeClient(() => ({
      http: 200,
      data: body,
      setCookies: [
        'sid=minted-session-value-1; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax',
        'csrf=csrf-token-value-1; Path=/; Max-Age=3600; Secure; SameSite=Lax',
      ],
    }));
    const before = registeredSecretCount();
    const grant = await mintSession(api, {
      handle: 'a0.owner',
      runId: '20261008T101500Z-ab12',
      sessionCookies: ['sid'],
      nowSeconds: now,
    });
    expect(api.calls).toEqual([
      {
        operationId: 'createSession',
        request: { body: { handle: 'a0.owner', runId: '20261008T101500Z-ab12', client: 'web' } },
      },
    ]);
    expect(grant.expiresAt).toBe(now + 3600);
    expect(grant.user).toEqual(body.user);
    expect(grant.cookies?.map((c) => [c.name, c.domain, c.expires, c.httpOnly])).toEqual([
      ['sid', 'dev-api.example.com', now + 3600, true],
      ['csrf', 'dev-api.example.com', now + 3600, false],
    ]);
    expect(registeredSecretCount()).toBe(before);
  });

  test('refuses a session without the expected cookie, one that is not HttpOnly, or no cookie at all', async () => {
    const noSid = fakeClient(() => ({ http: 200, data: body, setCookies: ['other=x; Path=/'] }));
    await expect(mintSession(noSid, { handle: 'a0.owner', runId: 'r', sessionCookies: ['sid'] })).rejects.toThrow(
      /set no sid cookie/,
    );
    const notHttpOnly = fakeClient(() => ({
      http: 200,
      data: body,
      setCookies: ['sid=visible-to-scripts-123; Path=/'],
    }));
    await expect(mintSession(notHttpOnly, { handle: 'a0.owner', runId: 'r', sessionCookies: ['sid'] })).rejects.toThrow(
      /not HttpOnly/,
    );
    const none = fakeClient(() => ({ http: 200, data: body, setCookies: [] }));
    await expect(mintSession(none, { handle: 'a0.owner', runId: 'r' })).rejects.toThrow(/set no cookie/);
    const noExpiry = fakeClient(() => ({ http: 200, data: { user: body.user }, setCookies: ['sid=v; HttpOnly'] }));
    await expect(mintSession(noExpiry, { handle: 'a0.owner', runId: 'r' })).rejects.toThrow(/without expiresAt/);
  });
});
