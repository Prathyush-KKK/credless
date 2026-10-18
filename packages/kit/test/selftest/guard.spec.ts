// The guard: what fails a test, what is let through and listed, and the named exceptions (G01–G14).
// Each check asserts the exact violation, then clears it, so the test proves the reason and still passes.
// The demo's pages are the `/__demo/*` routes of docs/conventions.md §10; its sentinels count what leaked.
import type { AttachedGuard } from '../../src/fixtures/guard.ts';
import { expect, type PersonaSession, test } from '../../src/index.ts';

type Expected = string | RegExp;

/** The guard the fixture attaches has the self-test hook the frozen `Guard` does not show. */
const attached = (session: PersonaSession) => session.guard as AttachedGuard;

/** Every one of these violations is reported (then cleared, so the test proves the reasons and still passes). */
async function expectViolations(session: PersonaSession, expected: Expected[]): Promise<void> {
  for (const text of expected) {
    await expect
      .poll(() => session.guard.violations.join('\n'), { message: `violation ${String(text)}` })
      .toMatch(text);
  }
  attached(session).clearViolations();
}

/** What reached the demo's sentinels (127.0.0.1:4319 over TCP, :3478 over UDP), which no persona may ever reach. */
async function sentinel(session: PersonaSession): Promise<{ hits: number; datagrams: number }> {
  // the persona's own request context: through its proxy, to the run's own origin, no page navigation
  const res = await session.context.request.get('/__demo/sentinel');
  return (await res.json()) as { hits: number; datagrams: number };
}

const LOOPBACK_ORIGIN = String.raw`http:\/\/127\.0\.0\.1:\d+`;

test.describe('guard', () => {
  test('G01 a console error fails the test', async ({ personas }) => {
    const [p] = await personas.open('owner');
    await p.goto('/__demo/console-error');
    await expectViolations(p, ['console error: boom from the app']);
    await p.shot();
  });

  test('G02 a request to an unlisted host is aborted and fails the test', async ({ personas }) => {
    const [p] = await personas.open('member');
    await p.goto('/__demo/outside');
    await expectViolations(p, ['request to an unlisted host: GET https://outside.example/beacon']);
    await p.shot();
  });

  test('G03 analytics never leave the browser; listed, not a failure', async ({ personas }) => {
    const [p] = await personas.open('guest');
    await p.goto('/__demo/analytics');
    await expect
      .poll(() => p.guard.analyticsBlocked.join('\n'))
      .toContain('GET https://www.googletagmanager.com/gtag/js');
    expect(p.guard.violations).toEqual([]);
    await p.shot();
  });

  test('G04 a request to production is refused and fails the test', async ({ personas }) => {
    const [p] = await personas.open('second-owner');
    await p.goto('/__demo/prod');
    await expectViolations(p, ['request to production refused: GET https://www.example.com/config']);
    await p.shot();
  });

  test('G05 an unexpected sign-out fails the test; an expected one is fine', async ({ personas }) => {
    const [a, b] = await personas.open('owner', 'member');
    await a.goto('/__demo/expired');
    await expectViolations(a, [/the session ended unexpectedly \(401\): GET .*\/api\/expired-on-purpose/]);
    await a.shot();
    b.guard.expectSignal(/\/api\/expired-on-purpose$/, 401);
    const answered = b.page.waitForResponse((r) => /\/api\/expired-on-purpose$/.test(new URL(r.url()).pathname));
    await b.goto('/__demo/expired');
    await answered;
    expect(b.guard.violations).toEqual([]);
    await b.shot();
  });

  test('G06 an HTTP error from the API fails the test unless the test expects that status', async ({ personas }) => {
    const [a, b] = await personas.open('guest', 'second-owner');
    await a.goto('/__demo/http-error');
    await expectViolations(a, [new RegExp(`HTTP 404: GET ${LOOPBACK_ORIGIN}/__demo/not-here`)]);
    await a.shot();
    b.guard.expectStatus(/\/__demo\/not-here$/, 404);
    const answered = b.page.waitForResponse((r) => /\/__demo\/not-here$/.test(new URL(r.url()).pathname));
    await b.goto('/__demo/http-error');
    await answered;
    expect(b.guard.violations).toEqual([]);
    await b.shot();
  });

  test('G07 violations left at the end fail the test (teardown)', async ({ personas }) => {
    test.fail(true, 'expected: the console error is not cleared, so the teardown fails the test');
    const [p] = await personas.open('owner');
    await p.goto('/__demo/console-error');
    await expect.poll(() => p.guard.violations.length).toBeGreaterThan(0);
    await p.shot();
  });

  test('G08 a console exception needs a reason; the run-wide guard knob covers every session', async ({
    personas,
    guard,
  }) => {
    const [p] = await personas.open('member');
    expect(() => p.guard.allowConsole(/boom/, '')).toThrow(/reason/);
    p.guard.allowConsole(/^boom from the app$/, 'self-test: the demo logs it on purpose');
    await p.goto('/__demo/console-error');
    await expect
      .poll(async () => (await p.page.consoleMessages()).some((m) => /boom from the app/.test(m.text())))
      .toBe(true);
    expect(p.guard.violations).toEqual([]);
    await p.shot();
    // the fixture-level knob: set once, honoured by a session opened afterwards
    guard.allowConsole(/^boom from the app$/, 'self-test: the demo logs it on purpose');
    const q = await personas.openSignedOut('guest');
    await q.goto('/__demo/console-error');
    await expect
      .poll(async () => (await q.page.consoleMessages()).some((m) => /boom from the app/.test(m.text())))
      .toBe(true);
    expect(q.guard.violations).toEqual([]);
    await q.shot();
  });

  test('G09 a redirect out of the app is refused before it connects (egress proxy), and fails the test', async ({
    personas,
  }) => {
    const [p] = await personas.open('guest');
    const before = await sentinel(p);
    await p.page.goto('/__demo/redirect-out').catch(() => undefined);
    await expectViolations(p, [
      new RegExp(
        `redirect to an unlisted host: GET ${LOOPBACK_ORIGIN}/__demo/redirect-out -> http://127\\.0\\.0\\.1:4319/landing`,
      ),
      'egress proxy refused an unlisted host: GET http://127.0.0.1:4319/landing',
    ]);
    expect((await sentinel(p)).hits, 'nothing reached the unlisted host, cookies or not').toBe(before.hits);
    await p.shot();
  });

  test('G10 a redirect to production is refused before any connection or DNS lookup', async ({ personas }) => {
    const [p] = await personas.open('second-owner');
    await p.page.goto('/__demo/redirect-prod').catch(() => undefined);
    await expectViolations(p, [
      new RegExp(
        `redirect to production: GET ${LOOPBACK_ORIGIN}/__demo/redirect-prod -> https://app\\.prod\\.example/j/abc`,
      ),
      'production refused by the egress proxy: CONNECT app.prod.example:443',
    ]);
    await p.shot();
  });

  test('G11 a WebSocket to an unlisted host or to production is closed before it connects', async ({ personas }) => {
    const [a, b] = await personas.open('owner', 'member');
    const before = await sentinel(a);
    await a.goto('/__demo/websocket');
    await expectViolations(a, ['websocket refused: ws://127.0.0.1:4319/socket']);
    expect((await sentinel(a)).hits).toBe(before.hits);
    await a.shot();
    await b.goto(`/__demo/websocket?to=${encodeURIComponent('wss://app.prod.example/socket')}`);
    await expectViolations(b, ['websocket refused: wss://app.prod.example/socket']);
    await b.shot();
  });

  test('G12 WebRTC sends no UDP around the egress proxy (STUN and TURN included)', async ({ personas }) => {
    const [p] = await personas.open('guest');
    const before = (await sentinel(p)).datagrams;
    await p.goto('/__demo/webrtc');
    // the page reports the end of ICE gathering; a browser that never finishes gets the same five seconds
    await p.page
      .getByText('gathering done')
      .waitFor({ timeout: 10_000 })
      .catch(() => p.page.waitForTimeout(5000));
    expect((await sentinel(p)).datagrams, 'datagrams that left the browser').toBe(before);
    await p.shot();
  });
});

test.describe('G13 the injected resolver', () => {
  const resolved: string[] = [];
  // a rebinding answer: loopback first, a second loopback alias after it (the pin itself is proven in unit test U12)
  test.use({
    egressLookup: {
      lookup: async (hostname) => {
        resolved.push(hostname);
        return [
          { address: '127.0.0.1', family: 4 },
          { address: '127.0.0.2', family: 4 },
        ];
      },
    },
  });

  test("G13 the persona's proxy resolves through the injected resolver, once per connection, never for an IP literal", async ({
    personas,
  }) => {
    const [p] = await personas.open('owner');
    await p.goto('/__demo/console-error');
    p.guard.allowConsole(/^boom from the app$/, 'self-test: the demo logs it on purpose');
    // nothing listens on dev.example.com:80 here, so the proxy answers 502 and the browser logs that line
    p.guard.allowConsole(/^Failed to load resource: .*502/, 'self-test: no server behind the resolved address');
    attached(p).clearViolations();
    expect(resolved, 'the own origin is an IP literal: nothing to resolve').toEqual([]);
    // a non-production host of the organisation on a web port: let through by the guard, resolved by the proxy
    const status = await p.page.evaluate(() =>
      window
        .fetch('http://dev.example.com/', { mode: 'no-cors', cache: 'no-store' })
        .then((r) => `status ${r.status}`)
        .catch((e: unknown) => `error ${String(e)}`),
    );
    expect(status).toMatch(/^(status|error)/);
    await expect.poll(() => resolved).toEqual(['dev.example.com']);
    await expect.poll(() => p.guard.devHosts.join('\n')).toContain('GET http://dev.example.com/');
    expect(p.guard.violations).toEqual([]);
    await p.shot();
  });
});
