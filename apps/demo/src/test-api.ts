// The reference implementation of the core test-API contract (contract/core.openapi.yaml) on the demo's state, plus
// the demo's extension routes (apps/demo/contract/demo.openapi.yaml) under the same base path.
//
// A backend team reads this file to see the seven seams a real backend implements: `personas.ensure/reset/state`,
// `session.mint/revoke`, `mail.list`, `cleanup` and `isTestAccount`. Everything HTTP (the key check, 401/403/404/422,
// JSON bodies, Set-Cookie) is the kit's `createTestApi`; nothing here reads a header.
//
// The demo runs from source with plain `node`, so it reaches the kit's source directly; an app that installs the
// package imports `createTestApi` from `credless/server` instead.

import {
  createTestApi,
  type ExtensionRoute,
  refuse,
  type TestApiServer,
} from '../../../packages/kit/src/server/index.ts';
import { PATTERNS, type SecretValue } from '../../../packages/kit/src/types.ts';
import { sessionCookies } from './api.ts';
import { type DemoState, now, type Workspace, type WorkspaceSpec } from './state.ts';

/** The address range the demo accepts for test accounts and invites; the kit's config enforces the same one. */
export const TEST_ADDRESS = /^qa\+[a-z0-9-]+@example\.com$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createDemoTestApi(
  state: DemoState,
  options: { key: SecretValue | string; basePath?: string },
): TestApiServer {
  /** The handle names a flagged test account (the same 404/403 the core routes give). */
  function testAccount(handle: unknown): string {
    if (typeof handle !== 'string' || !PATTERNS.handle.test(handle)) refuse(422, 'invalid', 'not a handle');
    const user = state.user(handle);
    if (!user) refuse(404, 'not-found', `no such test account: ${handle}`);
    if (!user.isTestAccount) refuse(403, 'not-test-account', `${handle} is not a test account`);
    return handle;
  }

  /** A workspace by id whose owner is a test account; 404 otherwise. */
  function testWorkspace(id: string | undefined): Workspace {
    const w = state.workspace(Number(id));
    if (!w) refuse(404, 'not-found', 'no such workspace');
    if (!state.owner(w).isTestAccount) refuse(403, 'not-test-account', 'not a test workspace');
    return w;
  }

  const api = createTestApi({
    key: options.key,
    basePath: options.basePath,
    environment: 'demo',
    version: 'demo',
    // Mail is captured in memory, pushes are logged as notifications, there is no analytics: all three are "wired".
    sinks: { mail: true, push: true, analytics: true },
    addressPattern: TEST_ADDRESS,
    personas: {
      ensure: async (specs) => specs.map((spec) => state.ensure(spec)),
      reset: async (handles) => handles.map((handle) => state.reset(handle)),
      state: async (handle) => state.state(handle),
    },
    session: {
      // The app's own login seam: the same cookies a web sign-in sets, tagged with the run id.
      mint: async ({ handle, runId }) => {
        const session = state.mint(handle, runId);
        const user = state.user(handle);
        if (!user) refuse(404, 'not-found', 'no such test account');
        state.log(`session ${handle} run ${runId}`);
        return {
          setCookies: sessionCookies(session),
          user: { userId: user.id, email: user.email, displayName: user.displayName },
          expiresAt: session.expiresAt,
        };
      },
      revoke: async (runId) => state.revoke(runId),
    },
    mail: { list: async (handle, query) => state.listMail(handle, query) },
    cleanup: async (runId) => state.cleanupRun(runId),
    isTestAccount: async (handle) => state.user(handle)?.isTestAccount ?? false,
  });

  const extensions: ExtensionRoute[] = [
    {
      operationId: 'createWorkspace',
      method: 'POST',
      path: '/workspaces',
      handler: ({ body }) => {
        if (!isRecord(body)) refuse(422, 'invalid', 'a workspace spec is required');
        if (typeof body.runId !== 'string' || !PATTERNS.runId.test(body.runId))
          refuse(422, 'invalid', 'runId is required');
        const owner = testAccount(body.owner);
        const list = (field: string): string[] => {
          const v = body[field];
          if (v === undefined) return [];
          if (!Array.isArray(v) || v.length > 8) refuse(422, 'invalid', `${field} must be a list of at most 8 handles`);
          return v.map((h) => testAccount(h));
        };
        const members = list('members');
        const guests = list('guests');
        const invites: WorkspaceSpec['invites'] = [];
        if (body.invites !== undefined) {
          if (!Array.isArray(body.invites) || body.invites.length > 8)
            refuse(422, 'invalid', 'invites must list at most 8 entries');
          for (const invite of body.invites) {
            if (!isRecord(invite) || typeof invite.email !== 'string')
              refuse(422, 'invalid', 'invite: email is required');
            if (!TEST_ADDRESS.test(invite.email))
              refuse(403, 'address-outside-range', 'invite address outside the test range');
            const s = invite.state ?? 'PENDING';
            if (s !== 'PENDING' && s !== 'EXPIRED' && s !== 'LOCKED') refuse(422, 'invalid', 'invite: unknown state');
            invites.push({ email: invite.email, state: s });
          }
        }
        const documents: Record<string, number> = {};
        if (body.documents !== undefined) {
          if (!isRecord(body.documents)) refuse(422, 'invalid', 'documents must map handles to counts');
          for (const [handle, count] of Object.entries(body.documents)) {
            if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 5)
              refuse(422, 'invalid', 'documents: 0 to 5 per handle');
            documents[testAccount(handle)] = count as number;
          }
        }
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 40))
          refuse(422, 'invalid', 'name: at most 40 characters');
        const seen = new Set<string>();
        for (const h of [owner, ...members, ...guests]) {
          if (seen.has(h)) refuse(422, 'invalid', `${h} is listed twice`);
          seen.add(h);
        }
        // Like a repository under one account: one live workspace of a name per owner.
        const name = body.name ?? `Team ${owner.split('.')[1] ?? owner} ${body.runId.slice(-4)}`;
        const clash = state
          .workspacesOf(owner)
          .find(({ workspace, member }) => member.role === 'owner' && workspace.name === name);
        if (clash) refuse(409, 'conflict', `${owner} already owns a live workspace named ${name}`);
        const w = state.createWorkspace({ runId: body.runId, owner, name, members, guests, invites, documents });
        // The code travels once, here, like the app shows it once; `getWorkspace` never repeats it.
        return { ...state.workspaceView(w), joinCode: w.joinCode };
      },
    },
    {
      operationId: 'getWorkspace',
      method: 'GET',
      path: '/workspaces/{id}',
      handler: ({ params }) => state.workspaceView(testWorkspace(params.id)),
    },
    {
      operationId: 'deleteWorkspace',
      method: 'DELETE',
      path: '/workspaces/{id}',
      handler: ({ params }) => {
        state.deleteWorkspace(testWorkspace(params.id));
        return { deleted: true };
      },
    },
    {
      operationId: 'lockLink',
      method: 'POST',
      path: '/workspaces/{id}/lock-link',
      handler: ({ params }) => {
        const w = testWorkspace(params.id);
        if (!w.locked) state.lock(w);
        return { locked: true };
      },
    },
    {
      operationId: 'expireInvite',
      method: 'POST',
      path: '/invites/{id}/expire',
      handler: ({ params }) => {
        const id = Number(params.id);
        for (const w of state.workspaces.values()) {
          const invite = w.invites.find((i) => i.id === id);
          if (invite && state.owner(w).isTestAccount) {
            invite.expiresAt = now() - 1;
            return { ...invite };
          }
        }
        return refuse(404, 'not-found', 'no such invite');
      },
    },
    {
      operationId: 'runSweeper',
      method: 'POST',
      path: '/sweepers/{name}/run',
      handler: ({ params, body }) => {
        const runId = isRecord(body) ? body.runId : undefined;
        const ns = isRecord(body) ? body.namespace : undefined;
        if (
          typeof runId !== 'string' ||
          !PATTERNS.runId.test(runId) ||
          typeof ns !== 'string' ||
          !PATTERNS.namespace.test(ns)
        ) {
          refuse(422, 'invalid', 'runId and namespace are required: a sweeper run is never global');
        }
        if (params.name !== 'invites') refuse(404, 'not-found', `no sweeper named ${params.name}`);
        const details = state.sweepInvites(runId, ns);
        return { name: params.name, ranAt: now(), changed: details.length, details };
      },
    },
    {
      operationId: 'getDocument',
      method: 'GET',
      path: '/documents/{id}',
      handler: ({ params }) => {
        const doc = state.docs.get(Number(params.id));
        if (!doc || doc.deleted) refuse(404, 'not-found', 'no such document');
        return state.docView(doc);
      },
    },
  ];

  return api.extend(extensions);
}
