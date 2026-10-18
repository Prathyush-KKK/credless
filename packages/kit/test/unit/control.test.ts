// The core control: persona ids to handles, the contract calls, codes as Secrets, and a teardown that removes what
// a test created newest-first and reports problems instead of throwing.
import { describe, expect, test } from 'vitest';
import { testApiMailSink } from '../../src/adapters/mail/test-api.ts';
import { handleForAddress, parseCatalog } from '../../src/core/catalog.ts';
import { Control } from '../../src/core/control.ts';
import { TestApiClient, TestApiError } from '../../src/core/test-api-client.ts';
import { type CallRequest, type CallResult, CORE_ROUTES, type RouteTable, type SecretValue } from '../../src/types.ts';

const catalog = parseCatalog(`
version: 1
addressTemplate: qa+{ns}-{persona}@example.com
lastNameTemplate: QA-{ns}
defaults: { locale: en-GB, timezone: Europe/London, auth: session }
personas:
  owner: { role: owner, firstName: Olive, purpose: owns }
  member: { role: member, firstName: Mo, purpose: joins, attributes: { plan: basic } }
addresses:
  ghost: { template: 'qa+{ns}-ghost@example.com', purpose: nobody }
`);

type Answer = (request: CallRequest) => unknown;

/** A scripted client: answers per operationId, records every call, throws TestApiError when told to. */
function scripted(answers: Record<string, Answer>, routes: RouteTable = CORE_ROUTES) {
  const calls: Array<{ operationId: string; request: CallRequest }> = [];
  const api: TestApiClient = Object.assign(Object.create(TestApiClient.prototype) as TestApiClient, {
    apiOrigin: 'https://dev-api.example.com',
    basePath: '/_test',
    routes,
    log: [],
    async call<T>(operationId: string, request: CallRequest = {}): Promise<CallResult<T>> {
      calls.push({ operationId, request });
      const answer = answers[operationId];
      if (!answer) throw new TestApiError(operationId, 404, 'not-found', `test API ${operationId} -> HTTP 404`);
      const data = answer(request);
      if (data instanceof Error) throw data;
      return { http: 200, data: data as T, setCookies: [] };
    },
  });
  return { api, calls };
}

function control(answers: Record<string, Answer>, routes?: RouteTable) {
  const { api, calls } = scripted(answers, routes);
  const secrets: SecretValue[] = [];
  const mail = testApiMailSink({
    api,
    handleFor: (address) => handleForAddress(address, 'a0', catalog),
    intervalMs: 5,
  });
  const c = new Control({
    api,
    catalog,
    ns: 'a0',
    runId: '20261008T101500Z-ab12',
    webOrigin: 'https://dev.example.com',
    mail,
    onSecret: (s) => secrets.push(s),
  });
  return { c, calls, secrets };
}

describe('personas and the contract calls', () => {
  test('ids map to handles and addresses; health is validated; ensure sends PersonaSpecs', async () => {
    const { c, calls } = control({
      health: () => ({ enabled: true, environment: 'dev', keyId: 'deadbeef', sinks: { mail: true } }),
      ensurePersonas: (r) => ({
        personas: (r.body as { personas: Array<{ handle: string }> }).personas.map((p) => ({
          handle: p.handle,
          userId: `u_${p.handle}`,
          created: true,
        })),
      }),
      personaState: (r) => ({ handle: r.params?.handle, userId: 'u', state: { workspaces: 1 } }),
      resetPersonas: () => ({ reset: [] }),
      cleanupRun: () => ({ removed: { workspaces: 2 }, sessionsRevoked: 3 }),
    });
    expect(c.ns).toBe('a0');
    expect(c.handle('owner')).toBe('a0.owner');
    expect(c.persona('member').email).toBe('qa+a0-member@example.com');
    expect(c.address('ghost')).toBe('qa+a0-ghost@example.com');
    expect(c.address('owner')).toBe('qa+a0-owner@example.com');
    expect(() => c.handle('nobody')).toThrow(/no persona "nobody"/);

    expect(await c.health()).toEqual({
      enabled: true,
      environment: 'dev',
      keyId: 'deadbeef',
      sinks: { mail: true },
      extensions: [],
    });
    const refs = await c.ensure(['owner', 'member']);
    expect(refs.map((r) => r.handle)).toEqual(['a0.owner', 'a0.member']);
    const sent = calls.at(-1)?.request.body as {
      personas: Array<{ handle: string; email: string; displayName: string; attributes: Record<string, unknown> }>;
    };
    expect(sent.personas[1]).toEqual({
      handle: 'a0.member',
      email: 'qa+a0-member@example.com',
      displayName: 'Mo QA-a0',
      attributes: {
        plan: 'basic',
        role: 'member',
        firstName: 'Mo',
        lastName: 'QA-a0',
        locale: 'en-GB',
        timezone: 'Europe/London',
        auth: 'session',
      },
    });
    expect(await c.ensure([])).toEqual([]);
    expect((await c.state('owner')).state).toEqual({ workspaces: 1 });
    expect(calls.at(-1)).toEqual({ operationId: 'personaState', request: { params: { handle: 'a0.owner' } } });
    c.touched.add('owner');
    await c.reset(['owner']);
    expect(calls.at(-1)).toEqual({ operationId: 'resetPersonas', request: { body: { handles: ['a0.owner'] } } });
    expect(c.touched.size).toBe(0);
    expect(await c.cleanupRun()).toEqual({ removed: { workspaces: 2 }, sessionsRevoked: 3 });
    expect(calls.at(-1)).toEqual({
      operationId: 'cleanupRun',
      request: { params: { runId: '20261008T101500Z-ab12' }, body: { revokeSessions: true } },
    });
  });

  test('health that is off, wrong, or from another namespace is refused with a clear message', async () => {
    const off = control({});
    await expect(off.c.health()).rejects.toThrow(
      /test API is not available on https:\/\/dev-api\.example\.com .*HTTP 404/,
    );
    const wrong = control({ health: () => ({ status: 'ok' }) });
    await expect(wrong.c.health()).rejects.toThrow(/did not answer health as the contract says/);
    const foreign = control({
      ensurePersonas: () => ({ personas: [{ handle: 'b1.owner', userId: 'u', created: false }] }),
    });
    await expect(foreign.c.ensure(['owner'])).rejects.toThrow(/b1\.owner, outside namespace a0/);
  });

  test('messages come through the sink with codes as Secrets handed to onSecret; waitForMessage polls', async () => {
    let polls = 0;
    const { c, calls, secrets } = control({
      personaMessages: (r) => {
        polls += 1;
        if (polls < 3 && r.query?.limit === 10) return { messages: [] };
        return {
          messages: [
            {
              id: 'm1',
              to: 'qa+a0-owner@example.com',
              subject: 'Your code',
              sentAt: 1,
              links: ['https://dev.example.com/j/abc'],
              codes: ['418203'],
              kind: 'auth',
            },
          ],
        };
      },
    });
    const first = await c.messages('owner', { kind: 'auth', since: 10 });
    expect(calls.at(-1)).toEqual({
      operationId: 'personaMessages',
      request: { params: { handle: 'a0.owner' }, query: { since: 10, kind: 'auth', limit: 10 } },
    });
    expect(first).toHaveLength(0);
    polls = 3;
    const [message] = await c.messages('owner');
    expect(message?.codes).toHaveLength(1);
    expect(String(message?.codes[0])).toBe('code 1 in mail m1=[redacted]');
    expect(JSON.stringify(message)).not.toContain('418203');
    expect(message?.codes[0]?.reveal()).toBe('418203');
    expect(secrets).toHaveLength(1);
    polls = 0;
    const waited = await c.waitForMessage('owner', /your code/i, { limit: 10, timeoutMs: 2000 });
    expect(waited.id).toBe('m1');
    expect(polls).toBe(3);
    expect(secrets).toHaveLength(2);
    await expect(c.waitForMessage('owner', (m) => m.subject === 'never', { timeoutMs: 30 })).rejects.toThrow(
      /no mail matching .* for qa\+a0-owner@example\.com reached the sink in 30 ms/,
    );
    await expect(c.messages('ghost')).rejects.toThrow(/test accounts only/);
  });
});

class AppControl extends Control {
  readonly removed: string[] = [];
  constructor(...args: ConstructorParameters<typeof Control>) {
    super(...args);
    this.removers.set('gadget', async (id) => {
      if (id === 'g-bad') throw new Error('gadget service down');
      this.removed.push(`gadget ${id}`);
    });
  }

  async widget(id: string): Promise<SecretValue> {
    this.track('widget', id);
    this.touched.add('owner');
    return this.secret(`code-for-${id}`, `widget ${id} code`);
  }

  gadget(id: string): void {
    this.track('gadget', id);
  }

  thing(id: string): void {
    this.track('thing', id);
  }

  async deleteWidget(id: string): Promise<void> {
    this.removed.push(`widget ${id}`);
  }

  forget(kind: string, id: string): void {
    this.untrack(kind, id);
  }

  mapped<T>(spec: T): T {
    return this.handles(spec);
  }
}

describe('teardown and the protected surface', () => {
  const routes: RouteTable = { ...CORE_ROUTES, deleteThing: { method: 'DELETE', path: '/things/{thingId}' } };

  test('removes newest-first through removers, delete<Kind>() or the delete<Kind> operation; reports problems; idempotent', async () => {
    const { api, calls } = scripted(
      {
        resetPersonas: () => ({ reset: [] }),
        deleteThing: (r) =>
          r.params?.thingId === 't-gone' ? new TestApiError('deleteThing', 404, 'not-found', 'gone') : {},
      },
      routes,
    );
    const secrets: SecretValue[] = [];
    const mail = testApiMailSink({ api, handleFor: () => null });
    const c = new AppControl({
      api,
      catalog,
      ns: 'a0',
      runId: 'r',
      webOrigin: 'https://dev.example.com',
      mail,
      onSecret: (s) => secrets.push(s),
    });
    const code = await c.widget('w1');
    expect(String(code)).toBe('widget w1 code=[redacted]');
    expect(secrets).toEqual([code]);
    c.gadget('g1');
    c.thing('t1');
    c.gadget('g-bad');
    c.thing('t-gone');
    c.thing('t-dup');
    c.thing('t-dup');
    c.forget('thing', 't-dup');
    await c.widget('w2');
    expect([...c.created.keys()]).toEqual(['widget', 'gadget', 'thing']);
    expect(c.created.get('thing')).toEqual(new Set(['t1', 't-gone']));
    expect(c.touched).toEqual(new Set(['owner']));

    const problems = await c.teardown();
    expect(problems).toEqual(['remove gadget g-bad: gadget service down']);
    expect(c.removed).toEqual(['widget w2', 'gadget g1', 'widget w1']);
    expect(calls.filter((x) => x.operationId === 'deleteThing').map((x) => x.request.params)).toEqual([
      { thingId: 't-gone' },
      { thingId: 't1' },
    ]);
    expect(calls.at(-1)).toEqual({ operationId: 'resetPersonas', request: { body: { handles: ['a0.owner'] } } });
    expect(c.created.size).toBe(0);
    expect(c.touched.size).toBe(0);
    expect(await c.teardown()).toEqual([]);
    expect(calls.filter((x) => x.operationId === 'resetPersonas')).toHaveLength(1);
  });

  test('a kind nobody can remove, and a reset that fails, are problems and not throws', async () => {
    const { api } = scripted({
      resetPersonas: () => new TestApiError('resetPersonas', 500, 'boom', 'test API resetPersonas -> HTTP 500'),
    });
    const c = new AppControl({
      api,
      catalog,
      ns: 'a0',
      runId: 'r',
      webOrigin: 'https://dev.example.com',
      mail: testApiMailSink({ api, handleFor: () => null }),
    });
    c.thing('t1');
    c.touched.add('member');
    expect(await c.teardown()).toEqual([
      'remove thing t1: no remover for thing: register one in removers, define deleteThing(id), or add the deleteThing operation to the contract',
      'reset member: test API resetPersonas -> HTTP 500',
    ]);
    expect(c.created.size).toBe(0);
  });

  test('handles() maps persona ids in strings, arrays and record keys, nothing else', () => {
    const { api } = scripted({});
    const c = new AppControl({
      api,
      catalog,
      ns: 'a0',
      runId: 'r',
      webOrigin: 'https://dev.example.com',
      mail: testApiMailSink({ api, handleFor: () => null }),
    });
    expect(
      c.mapped({
        owner: 'owner',
        members: ['member', 'ghost'],
        documents: { member: 2, owner: 1 },
        mixed: { member: 2, other: 1 },
        name: 'owner workspace',
        nested: { who: 'member' },
        n: 3,
        when: null,
      }),
    ).toEqual({
      owner: 'a0.owner',
      members: ['a0.member', 'ghost'],
      documents: { 'a0.member': 2, 'a0.owner': 1 },
      mixed: { member: 2, other: 1 },
      name: 'owner workspace',
      nested: { who: 'a0.member' },
      n: 3,
      when: null,
    });
    expect(c.mapped('owner')).toBe('a0.owner');
    const date = new Date(0);
    expect(c.mapped({ date }).date).toBe(date);
  });
});
