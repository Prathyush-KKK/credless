// The test API through the kit, against the demo app: health, ensure, sessions, refusals, the workspace control and
// cleanup (A01–A03, C01, C04, C05 of the private suite). Everything goes through the worker's client, so through the
// broker: no key, no origin and no handle is spelled in this file.
import type { CreateSessionResponse, PersonaRef, SecretValue, StateControl } from '../../src/index.ts';
import { expect, test } from '../../src/index.ts';

/** The demo's extension (apps/demo/e2e/demo.control.ts), as much of it as these tests use. */
interface DemoControlLike extends StateControl {
  workspace(spec: {
    owner: string;
    members?: string[];
    guests?: string[];
    invites?: Array<{ to: string }>;
    documents?: Record<string, number>;
    name?: string;
  }): Promise<WorkspaceLike>;
  refresh(ws: WorkspaceLike | number): Promise<WorkspaceLike>;
  deleteWorkspace(ws: WorkspaceLike | number): Promise<void>;
}
interface WorkspaceLike {
  id: number;
  name: string;
  joinUrl: string;
  joinCode: SecretValue | null;
  locked: boolean;
  members: Array<{ persona: string; role: string; state: string }>;
  invites: Array<{ email: string; state: string }>;
  documents: Array<{ id: number; title: string; uploadedBy: string; path: string; url: string }>;
  document(index?: number): WorkspaceLike['documents'][number];
  invite(email: string): WorkspaceLike['invites'][number];
}

interface HttpError {
  http?: number;
  code?: string | null;
  message?: string;
}

const failureOf = (promise: Promise<unknown>): Promise<HttpError> =>
  promise.then(
    () => ({}),
    (e: unknown) => e as HttpError,
  );

test.describe('test API through the broker', () => {
  test('A01 health, ensure (idempotent) and a full session with HttpOnly cookies', async ({ kit, control }) => {
    const health = await control.health();
    expect(health.enabled).toBe(true);
    expect(health.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(health.extensions).toContain('createWorkspace');
    const first = await control.ensure(['owner', 'member']);
    const again = await control.ensure(['owner', 'member']);
    expect(first.every((p: PersonaRef) => p.userId.length > 0)).toBe(true);
    expect(again.map((p: PersonaRef) => p.created)).toEqual([false, false]);
    expect(again.map((p: PersonaRef) => p.userId)).toEqual(first.map((p: PersonaRef) => p.userId));

    const { data, setCookies } = await kit.api.call<CreateSessionResponse>('createSession', {
      body: { handle: control.handle('member'), runId: control.runId },
    });
    const sid = setCookies.find((c: string) => c.startsWith('sid='));
    expect(sid, 'the session cookie the app itself sets').toBeDefined();
    expect(sid).toMatch(/;\s*HttpOnly/i);
    expect(sid).toMatch(/;\s*SameSite=Lax/i);
    expect(sid).toMatch(/;\s*Max-Age=3600/i);
    expect(setCookies.find((c: string) => c.startsWith('csrf='))).not.toMatch(/HttpOnly/i);
    expect(data.user.email).toBe(control.persona('member').email);
    expect(data.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3000);
    expect(data.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
  });

  test('A02 refusals: a real account is 403, an unknown handle 404, and the message quotes nothing', async ({
    kit,
  }) => {
    const real = await failureOf(kit.api.call('personaState', { params: { handle: 'a9.real' } }));
    expect(real.http).toBe(403);
    expect(real.code).toBe('not-test-account');
    const unknown = await failureOf(kit.api.call('personaState', { params: { handle: 'z9.nobody' } }));
    expect(unknown.http).toBe(404);
    expect(unknown.code).toBe('not-found');
    const session = await failureOf(
      kit.api.call('createSession', { body: { handle: 'a9.real', runId: kit.config.runId } }),
    );
    expect(session.http).toBe(403);
    for (const error of [real, unknown, session]) {
      expect(error.message ?? '').not.toMatch(/X-Test-Runner-Key:|X-Test-Broker-Token:|sid=/i);
    }
  });

  test('A03 a second session for the same account ends the first, as a login does', async ({ kit, control }) => {
    await control.ensure(['member']);
    const mint = () =>
      kit.api.call<CreateSessionResponse>('createSession', {
        body: { handle: control.handle('member'), runId: control.runId },
      });
    const one = await mint();
    const two = await mint();
    expect(one.setCookies.find((c: string) => c.startsWith('sid='))).not.toBe(
      two.setCookies.find((c: string) => c.startsWith('sid=')),
    );
    // the demo reports live sessions per account: one, not two
    expect((await control.state('member')).state.sessions).toBe(1);
  });
});

test.describe('workspace control', () => {
  test('C01 a workspace in one call: members, guests, invites, documents; the code is a Secret', async ({
    kit,
    control,
  }) => {
    const demo = control as DemoControlLike;
    const ws = await demo.workspace({
      owner: 'owner',
      members: ['member'],
      guests: ['guest'],
      documents: { member: 1 },
      invites: [{ to: 'ghost' }],
    });
    expect(ws.members.map((m) => [m.persona, m.role, m.state])).toEqual([
      ['owner', 'owner', 'ACTIVE'],
      ['member', 'member', 'ACTIVE'],
      ['guest', 'guest', 'ACTIVE'],
    ]);
    expect(ws.document(0).uploadedBy).toBe('member');
    expect(ws.document(0).url).toBe(`${kit.config.endpoints.web}${ws.document(0).path}`);
    expect(ws.document(0).title).toMatch(/^Doc [a-z0-9]{4}-\d+ member-1$/);
    expect(ws.invite(control.address('ghost')).state).toBe('PENDING');
    expect(ws.joinUrl.startsWith(`${kit.config.endpoints.web}/j/`)).toBe(true);
    // booleans on purpose: a failing toMatch or toContain would print the code in its message
    expect(/^\d{6}$/.test(ws.joinCode?.reveal() ?? '')).toBe(true);
    expect(JSON.stringify(ws).includes(ws.joinCode?.reveal() ?? 'never')).toBe(false);
    expect(String(ws.joinCode)).toContain('[redacted]');
    expect(() => ws.document(3)).toThrow(/no index 3/);
    expect(control.created.get('workspace')?.has(String(ws.id))).toBe(true);
    expect([...control.touched].sort()).toEqual(['guest', 'member', 'owner']);
    expect(await control.teardown()).toEqual([]);
    expect(control.created.size).toBe(0);
    expect((await control.state('owner')).state.workspaces).toEqual([]);
  });

  test('C04 refused: unknown persona ids fail before any call; a second live workspace of one name is 409', async ({
    control,
  }) => {
    const demo = control as DemoControlLike;
    await expect(demo.workspace({ owner: 'zz' })).rejects.toThrow(/no persona "zz"/);
    const ws = await demo.workspace({ owner: 'owner' });
    const again = await failureOf(demo.workspace({ owner: 'owner' }));
    expect(again.http).toBe(409);
    expect(again.code).toBe('conflict');
    const other = await demo.workspace({ owner: 'owner', name: `Other ${ws.id}` }); // a different name is fine
    expect(other.id).not.toBe(ws.id);
    await demo.deleteWorkspace(ws);
    await demo.deleteWorkspace(ws); // deleting twice is fine
    expect(await control.teardown()).toEqual([]);
  });

  test('C05 the run cleanup closes what a crashed test left behind', async ({ control }) => {
    const demo = control as DemoControlLike;
    const ws = await demo.workspace({ owner: 'owner', documents: { owner: 2 } });
    control.created.clear(); // as if the test process died before teardown
    const cleaned = await control.cleanupRun();
    expect(cleaned.removed.workspaces).toBeGreaterThanOrEqual(1);
    expect(cleaned.removed.documents).toBeGreaterThanOrEqual(2);
    expect((await control.state('owner')).state.workspaces).toEqual([]);
    const gone = await failureOf(
      demo.refresh(ws.id).then((w) => (w.locked ? w : Promise.reject(new Error('still live')))),
    );
    expect(gone.message).toBe('still live'); // the view is still readable; the workspace is DELETED, not forgotten
    await control.reset(['owner']);
  });
});
