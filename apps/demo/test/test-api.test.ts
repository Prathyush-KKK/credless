// The demo as a process: `node src/server.ts` prints the ready line, serves the seven core routes and the extension
// routes under /_test with the key from CREDLESS_DEMO_KEY_FILE, and the app routes next to them. The same sequence
// a person runs with curl, kept repeatable.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const serverFile = path.resolve(import.meta.dirname, '../src/server.ts');
const RUN = '20261018T120000Z-ab12';

interface Demo {
  web: string;
  api: string;
  stop(): Promise<void>;
}

/** Start the demo without sentinels (two test files may run at once) and wait for its ready line. */
function startDemo(args: string[], env: Record<string, string>): Promise<Demo> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverFile, '--no-sentinels', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = /ready web=(\S+) api=(\S+)/.exec(out);
      if (m) {
        resolve({
          web: m[1] ?? '',
          api: m[2] ?? '',
          stop: () =>
            new Promise<void>((done) => {
              child.once('exit', () => done());
              child.kill('SIGTERM');
            }),
        });
      }
    });
    child.once('exit', (code) => reject(new Error(`demo exited with ${code} before it was ready: ${err || out}`)));
    setTimeout(() => reject(new Error(`demo did not print the ready line in time: ${err || out}`)), 15_000).unref();
  });
}

describe('the demo server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-test-'));
  const keyFile = path.join(dir, 'key');
  const KEY = crypto.randomBytes(16).toString('hex');
  let demo: Demo;

  beforeAll(async () => {
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    demo = await startDemo([], { CREDLESS_DEMO_KEY_FILE: keyFile });
  });
  afterAll(async () => {
    await demo?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (p: string, init: RequestInit = {}, key: string | null = KEY) =>
    fetch(`${demo.api}${p}`, {
      ...init,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'X-Test-Runner-Key': key } : {}),
        ...(init.headers ?? {}),
      },
    });
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  const persona = (id: string, first: string, auth = 'session') => ({
    handle: `a0.${id}`,
    email: `qa+a0-${id}@example.com`,
    displayName: `${first} QA-a0`,
    attributes: { role: id, firstName: first, lastName: 'QA-a0', auth },
  });
  const cookieOf = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '';
  const bare = (cookie: string) => cookie.split(';')[0] ?? '';

  test('prints the ready line with two loopback origins and serves the page with the api origin filled in', async () => {
    expect(demo.web).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(demo.api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await (await fetch(`${demo.web}/w/1`)).text();
    expect(page).toContain(`const API = '${demo.api}'`);
    expect(page).toContain('data-boot-cover');
    expect(await (await fetch(`${demo.web}/__demo/sentinel`)).json()).toEqual({ hits: 0, datagrams: 0 });
    const redirect = await fetch(`${demo.web}/__demo/redirect-prod`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://app.prod.example/j/abc');
  });

  test('the key: 401 without or with a wrong key, 404 outside the base path, health with the key', async () => {
    expect(await json(await call('/_test/health', {}, null))).toMatchObject({
      status: 401,
      body: { error: { code: 'bad-key' } },
    });
    expect(await json(await call('/_test/health', {}, 'definitely-wrong'))).toMatchObject({
      status: 401,
      body: { error: { code: 'bad-key' } },
    });
    expect(await json(await call('/_tes/health'))).toMatchObject({
      status: 404,
      body: { error: { code: 'not-found' } },
    });
    const health = await json(await call('/_test/health'));
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      enabled: true,
      environment: 'demo',
      sinks: { mail: true, push: true, analytics: true },
    });
    expect(health.body.keyId).toBe(crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 8));
    expect(health.body.extensions).toEqual([
      'createWorkspace',
      'getWorkspace',
      'deleteWorkspace',
      'lockLink',
      'expireInvite',
      'runSweeper',
      'getDocument',
    ]);
  });

  test('ensure is idempotent; a session sets sid (HttpOnly) and csrf; a second session ends the first', async () => {
    const body = JSON.stringify({
      personas: [persona('owner', 'Ada'), persona('member', 'Ben'), persona('signin', 'Eve', 'password')],
    });
    const first = await json(await call('/_test/personas/ensure', { method: 'POST', body }));
    const again = await json(await call('/_test/personas/ensure', { method: 'POST', body }));
    expect((first.body.personas as Array<{ created: boolean }>).map((p) => p.created)).toEqual([true, true, true]);
    expect((again.body.personas as Array<{ created: boolean }>).map((p) => p.created)).toEqual([false, false, false]);
    const ids = (body: Record<string, unknown>) => (body.personas as Array<{ userId: string }>).map((p) => p.userId);
    expect(ids(again.body)).toEqual(ids(first.body));

    const one = await call('/_test/session', {
      method: 'POST',
      body: JSON.stringify({ handle: 'a0.member', runId: RUN }),
    });
    expect(one.status).toBe(200);
    expect(cookieOf(one, 'sid')).toMatch(/; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/);
    expect(cookieOf(one, 'csrf')).toMatch(/; Path=\/; Max-Age=3600; SameSite=Lax$/);
    expect(await one.json()).toMatchObject({ user: { email: 'qa+a0-member@example.com', displayName: 'Ben QA-a0' } });
    const two = await call('/_test/session', {
      method: 'POST',
      body: JSON.stringify({ handle: 'a0.member', runId: RUN }),
    });
    expect((await fetch(`${demo.api}/api/me`, { headers: { cookie: bare(cookieOf(one, 'sid')) } })).status).toBe(401);
    expect((await fetch(`${demo.api}/api/me`, { headers: { cookie: bare(cookieOf(two, 'sid')) } })).status).toBe(200);
    expect((await json(await call('/_test/personas/a0.member'))).body).toMatchObject({ state: { sessions: 1 } });
  });

  test('refusals: a real account is 403, an unknown handle 404, an address outside the range 403', async () => {
    expect((await call('/_test/personas/a9.real')).status).toBe(403);
    expect(
      (await call('/_test/session', { method: 'POST', body: JSON.stringify({ handle: 'a9.real', runId: RUN }) }))
        .status,
    ).toBe(403);
    expect((await call('/_test/personas/z9.nobody')).status).toBe(404);
    const outside = await call('/_test/personas/ensure', {
      method: 'POST',
      body: JSON.stringify({ personas: [{ ...persona('x', 'Xi'), email: 'x@example.net' }] }),
    });
    expect(outside.status).toBe(403);
  });

  test('a workspace in one call, the invite mail with link and code, the app routes with the cookie and CSRF', async () => {
    const created = await json(
      await call('/_test/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          runId: RUN,
          owner: 'a0.owner',
          invites: [{ email: 'qa+a0-member@example.com' }],
          documents: { 'a0.owner': 1 },
        }),
      }),
    );
    expect(created.status).toBe(200);
    const ws = created.body as {
      id: number;
      joinUrl: string;
      joinCode: string;
      documents: Array<{ id: number; path: string }>;
    };
    expect(ws.joinCode).toMatch(/^\d{6}$/);
    expect(ws.joinUrl.startsWith(`${demo.web}/j/`)).toBe(true);
    expect((await json(await call(`/_test/workspaces/${ws.id}`))).body).not.toHaveProperty('joinCode');
    expect(
      (await call('/_test/workspaces', { method: 'POST', body: JSON.stringify({ runId: RUN, owner: 'a0.owner' }) }))
        .status,
    ).toBe(409);

    const mail = await json(await call('/_test/personas/a0.member/messages?kind=invite'));
    expect(mail.body.messages).toEqual([
      expect.objectContaining({
        to: 'qa+a0-member@example.com',
        links: [ws.joinUrl],
        codes: [ws.joinCode],
        kind: 'invite',
      }),
    ]);

    const session = await call('/_test/session', {
      method: 'POST',
      body: JSON.stringify({ handle: 'a0.member', runId: RUN }),
    });
    const sid = bare(cookieOf(session, 'sid'));
    const csrf = bare(cookieOf(session, 'csrf')).slice('csrf='.length);
    const doc = ws.documents[0];
    expect(doc).toBeDefined();
    if (!doc) return;
    expect((await fetch(`${demo.api}/api/documents/${doc.id}`, { headers: { cookie: sid } })).status).toBe(404); // not a member yet
    const token = ws.joinUrl.split('/j/')[1] ?? '';
    const headers = { cookie: `${sid}; csrf=${csrf}`, 'content-type': 'application/json' };
    expect(
      (
        await fetch(`${demo.api}/api/join/${token}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ code: ws.joinCode }),
        })
      ).status,
    ).toBe(403); // no CSRF header
    const wrong = await json(
      await fetch(`${demo.api}/api/join/${token}`, {
        method: 'POST',
        headers: { ...headers, 'x-csrf-token': csrf },
        body: JSON.stringify({ code: '000000' }),
      }),
    );
    expect(wrong).toMatchObject({
      status: 422,
      body: { error: { code: 'wrong-code', message: "That code doesn't match. 4 tries left." } },
    });
    const joined = await fetch(`${demo.api}/api/join/${token}`, {
      method: 'POST',
      headers: { ...headers, 'x-csrf-token': csrf },
      body: JSON.stringify({ code: ws.joinCode }),
    });
    expect(joined.status).toBe(200);
    expect((await fetch(`${demo.api}/api/documents/${doc.id}`, { headers: { cookie: sid } })).status).toBe(200);
    expect((await json(await fetch(`${demo.api}/api/search?q=doc`, { headers: { cookie: sid } }))).body).toEqual({
      results: [expect.objectContaining({ id: doc.id })],
    });
    expect((await json(await call('/_test/personas/a0.member'))).body).toMatchObject({
      state: { workspaces: [{ id: ws.id, role: 'member' }] },
    });

    // the sign-in persona signs in through the app with the stand-in password; a session account cannot
    const password = (
      JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../src/fake-secrets.json'), 'utf8')) as {
        signinPassword: string;
      }
    ).signinPassword;
    const login = await fetch(`${demo.api}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'qa+a0-signin@example.com', password }),
    });
    expect(login.status).toBe(200);
    expect(cookieOf(login, 'sid')).toMatch(/HttpOnly/);
    const refused = await fetch(`${demo.api}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'qa+a0-owner@example.com', password }),
    });
    expect(refused.status).toBe(401);

    // the self-test routes of docs/conventions.md §10 on the api origin
    expect(await json(await fetch(`${demo.api}/api/expired-on-purpose`))).toMatchObject({
      status: 401,
      body: { error: { code: 'session-expired' } },
    });
    expect((await fetch(`${demo.api}/__demo/not-here`)).status).toBe(404);
    const redirect = await fetch(`${demo.api}/__demo/api-redirect`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('http://127.0.0.1:4319/from-api');
    const state = await json(await fetch(`${demo.api}/__demo/state`));
    expect(JSON.stringify(state.body)).not.toContain(ws.joinCode);
    expect(JSON.stringify(state.body)).not.toContain(sid.slice('sid='.length));

    // cleanup removes the run's objects and revokes its sessions; a second cleanup answers zeros
    const cleaned = await json(await call(`/_test/runs/${RUN}/cleanup`, { method: 'POST' }));
    expect(cleaned.body).toMatchObject({ removed: { workspaces: 1, documents: 1 } });
    expect(cleaned.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${demo.api}/api/me`, { headers: { cookie: sid } })).status).toBe(401);
    expect((await json(await call(`/_test/runs/${RUN}/cleanup`, { method: 'POST', body: '{}' }))).body).toEqual({
      removed: { workspaces: 0, documents: 0 },
      sessionsRevoked: 0,
    });
  });
});

describe('the demo server without the test API, and with a generated key', () => {
  test('--no-test-api leaves the base path as unknown as any other path (plain 404)', async () => {
    const demo = await startDemo(['--no-test-api'], {});
    try {
      const res = await fetch(`${demo.api}/_test/health`, { headers: { 'X-Test-Runner-Key': 'anything' } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not-found', message: 'Not found' } });
    } finally {
      await demo.stop();
    }
  });

  test('--write-key writes a fresh 0600 key file the kit can read, and refuses to overwrite one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-key-'));
    const file = path.join(dir, 'staging', 'demo-key');
    const demo = await startDemo(['--write-key', file], {});
    try {
      const key = fs.readFileSync(file, 'utf8');
      expect(key.length).toBeGreaterThanOrEqual(32);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect((await fetch(`${demo.api}/_test/health`, { headers: { 'X-Test-Runner-Key': key } })).status).toBe(200);
      await expect(startDemo(['--write-key', file], {})).rejects.toThrow(/EEXIST/);
    } finally {
      await demo.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
