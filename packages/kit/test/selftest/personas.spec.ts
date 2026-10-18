// personas.open(): one signed-in browser per persona, the evidence rules, and the refusals (P01–P08).
import { evidenceExists, shotPath } from '../../src/fixtures/evidence.ts';
import { expect, type PersonaSession, see, test } from '../../src/index.ts';

/** The demo's session cookie (docs/conventions.md §10). */
const SESSION_COOKIE = 'sid';

async function sentinelHits(session: PersonaSession): Promise<number> {
  const res = await session.context.request.get('/__demo/sentinel');
  return ((await res.json()) as { hits: number }).hits;
}

test.describe('personas', () => {
  test('P01 two personas, each in its own browser, already signed in', async ({ personas }, testInfo) => {
    const [owner, member] = await personas.open('owner', 'member');
    await owner.goto('/');
    await member.goto('/');
    await see(owner.page, owner.persona.firstName);
    await see(member.page, member.persona.firstName);
    expect(owner.guard.canarySeen && member.guard.canarySeen, 'each context reached its own proxy').toBe(true);
    const [a, b] = await Promise.all([owner.context.cookies(), member.context.cookies()]);
    const session = (list: typeof a) => list.find((c) => c.name === SESSION_COOKIE);
    expect(session(a)?.httpOnly).toBe(true);
    expect(session(a)?.value).not.toBe(session(b)?.value);
    const files = [await owner.shot('home'), await member.shot('home')];
    for (const file of files) expect(evidenceExists(file), file).toBe(true);
    expect(files[0]).toMatch(
      new RegExp(
        `P01-two-personas-each-in-its-own-browser-already-signed-in--owner-home-${testInfo.project.name}\\.png$`,
      ),
    );
    expect(files[0]).toBe(shotPath(testInfo, 'owner', 'home'));
  });

  test('P02 a persona opens once per test (a second session would end the first)', async ({ personas }) => {
    await personas.open('member');
    await expect(personas.open('member')).rejects.toThrow(/already open/);
    await expect(personas.open('guest', 'guest')).rejects.toThrow(/already open/);
    await expect(personas.openSignedOut('member')).rejects.toThrow(/already open/);
  });

  test('P03 the sign-in persona never gets a session from the endpoint; catalog addresses resolve', async ({
    personas,
  }) => {
    await expect(personas.open('signin')).rejects.toThrow(/sign-in persona/);
    expect(personas.persona('signin').auth).toBe('password');
    expect(personas.persona('owner').handle).toMatch(/^[a-z][0-9]{1,2}\.owner$/);
    expect(personas.address('ghost')).toMatch(/^qa\+[a-z][0-9]{1,2}-ghost@example\.com$/);
    await expect(personas.open()).rejects.toThrow(/at least one persona/);
  });

  test('P08 persona.api() calls the API origin only, with the session, and follows no redirect', async ({
    personas,
  }) => {
    const [p] = await personas.open('member');
    const state = await p.api('/__demo/state');
    expect(state.http).toBe(200);
    expect(state.signal).toBeNull();
    expect(state.data).not.toBeNull();
    const missing = await p.api('/__demo/not-here');
    expect([missing.http, missing.signal], 'an error status is returned with its signal, never thrown').toEqual([
      404, 404,
    ]);
    for (const elsewhere of [
      'https://outside.example/__demo/state',
      '//outside.example/__demo/state',
      'http://127.0.0.1:4319/landing',
    ]) {
      await expect(p.api(elsewhere), elsewhere).rejects.toThrow(/only calls http:\/\/127\.0\.0\.1:\d+/);
    }
    const before = await sentinelHits(p);
    const redirected = await p.api('/__demo/api-redirect');
    expect(redirected.http, 'the redirect is returned, not followed').toBe(302);
    expect(await sentinelHits(p)).toBe(before);
    expect(p.guard.violations).toEqual([]);
  });

  test('P04 a test that opened a screen but saved no screenshot fails', async ({ personas }) => {
    test.fail(true, 'expected: the evidence rule fails a passing test with no screenshot');
    const [p] = await personas.open('guest');
    await p.goto('/');
    await see(p.page, p.persona.firstName);
  });
});

test.describe('evidence of a failed test', () => {
  test.describe.configure({ mode: 'serial' });
  let failedShot = '';
  let project = '';

  test('P05 a failing test leaves a FAILED screenshot for the triage', async ({ personas }, testInfo) => {
    test.fail(true, 'expected: this test fails on purpose');
    const [p] = await personas.open('second-owner');
    await p.goto('/');
    failedShot = shotPath(testInfo, 'second-owner', 'FAILED');
    project = testInfo.project.name;
    await see(p.page, 'This text is not on the page', 1000);
  });

  test('P06 the FAILED screenshot of P05 exists', async () => {
    expect(failedShot).toMatch(new RegExp(`--second-owner-FAILED-${project}\\.png$`));
    expect(evidenceExists(failedShot)).toBe(true);
  });
});

test.describe('signed out', () => {
  test('P07 a persona with no session has no cookies; the guard and the canary still run', async ({ personas }) => {
    const p = await personas.openSignedOut('signin');
    await p.goto('/');
    expect(await p.context.cookies()).toEqual([]);
    expect(p.guard.canarySeen).toBe(true);
    expect(p.guard.label).toBe(p.persona.handle);
    await expect(p.page.locator('body')).not.toBeEmpty();
    expect(p.guard.violations).toEqual([]);
    await p.shot('signed-out');
  });
});
