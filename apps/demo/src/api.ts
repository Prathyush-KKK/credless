// The demo app's own API (the api origin): what a real app has. Cookie session `sid` (HttpOnly), CSRF double-submit
// `csrf` + `X-CSRF-Token` on every mutation, 401 on a missing session (the kit's sign-out signal), plain JSON
// errors `{ error: { code, message } }`, CORS for the web origin only. Plus the `/__demo/*` routes of
// docs/conventions.md §10 that the kit's self-tests point the guard at.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DemoState, Session, User, Workspace } from './state.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

/** The sentinel the self-tests count leaks on (docs/conventions.md §10); a request reaching it is a leak. */
export const SENTINEL_HTTP = 'http://127.0.0.1:4319';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a Cookie header into names and values. */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The app's login seam: the `Set-Cookie` values a sign-in sends. The test API's `/session` reuses it, so a minted
 * session has exactly the cookies a web login sets. (`Secure` is omitted because the demo serves plain http on
 * loopback; a real app adds it.)
 */
export function sessionCookies(session: Session): string[] {
  const ttl = Math.max(0, session.expiresAt - Math.floor(Date.now() / 1000));
  return [
    `sid=${session.sid}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Lax`,
    `csrf=${session.csrf}; Path=/; Max-Age=${ttl}; SameSite=Lax`,
  ];
}

const clearedCookies = ['sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax', 'csrf=; Path=/; Max-Age=0; SameSite=Lax'];

export function createAppApi(state: DemoState): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const cors = (req: IncomingMessage): Record<string, string> =>
    req.headers.origin === state.webOrigin
      ? {
          'Access-Control-Allow-Origin': state.webOrigin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
          Vary: 'Origin',
        }
      : {};

  function send(ctx: Ctx, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
    ctx.res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors(ctx.req),
      ...headers,
    });
    ctx.res.end(JSON.stringify(body));
  }
  const fail = (ctx: Ctx, status: number, code: string, message: string) =>
    send(ctx, status, { error: { code, message } });

  /** The signed-in user, or a 401; mutations also need the CSRF header to match the cookie (403 otherwise). */
  function signedIn(ctx: Ctx): User | null {
    const cookies = parseCookies(ctx.req);
    const who = state.whoami(cookies.sid);
    if (!who) {
      fail(ctx, 401, 'unauthenticated', 'Sign in to continue');
      return null;
    }
    if (ctx.req.method !== 'GET' && ctx.req.headers['x-csrf-token'] !== who.session.csrf) {
      fail(ctx, 403, 'csrf', 'Missing or wrong CSRF token');
      return null;
    }
    return who.user;
  }

  /** A live workspace the user is an active member of, or a 404 (a non-member learns nothing, not even that it exists). */
  function memberOf(ctx: Ctx, user: User): { workspace: Workspace; role: string } | null {
    const workspace = state.workspace(Number(ctx.params.id));
    const member = workspace ? state.membership(workspace, user.handle) : undefined;
    if (!workspace || !member) {
      fail(ctx, 404, 'not-found', 'Not found');
      return null;
    }
    return { workspace, role: member.role };
  }

  const routes: Array<[string, string, Handler]> = [
    // -- /__demo/*: for the kit's self-tests (docs/conventions.md §10) ------------------------------------------
    ['GET', '/__demo/not-here', (ctx) => fail(ctx, 404, 'not-found', 'Not found')],
    [
      'GET',
      '/__demo/api-redirect',
      (ctx) => {
        // An API answer that redirects out, to the sentinel: a persona's api() must not follow it.
        ctx.res.writeHead(302, { Location: `${SENTINEL_HTTP}/from-api`, ...cors(ctx.req) });
        ctx.res.end();
      },
    ],
    ['GET', '/__demo/state', (ctx) => send(ctx, 200, state.introspect())],
    ['GET', '/api/expired-on-purpose', (ctx) => fail(ctx, 401, 'session-expired', 'Session expired')],

    // -- sign-in and session --------------------------------------------------------------------------------------
    [
      'POST',
      '/api/login',
      (ctx) => {
        const email = isRecord(ctx.body) && typeof ctx.body.email === 'string' ? ctx.body.email : '';
        const password = isRecord(ctx.body) && typeof ctx.body.password === 'string' ? ctx.body.password : '';
        const session = email && password ? state.login(email, password) : null;
        if (!session) return fail(ctx, 401, 'invalid-credentials', 'That email or password is wrong.');
        const user = state.user(session.handle) as User;
        send(ctx, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookies(session) });
      },
    ],
    [
      'POST',
      '/api/logout',
      (ctx) => {
        if (!signedIn(ctx)) return;
        state.logout(parseCookies(ctx.req).sid);
        send(ctx, 200, { signedOut: true }, { 'Set-Cookie': clearedCookies });
      },
    ],
    [
      'GET',
      '/api/me',
      (ctx) => {
        const user = signedIn(ctx);
        if (user) send(ctx, 200, { user: publicUser(user) });
      },
    ],

    // -- workspaces -----------------------------------------------------------------------------------------------
    [
      'GET',
      '/api/workspaces',
      (ctx) => {
        const user = signedIn(ctx);
        if (!user) return;
        const workspaces = state.workspacesOf(user.handle).map(({ workspace, member }) => ({
          id: workspace.id,
          name: workspace.name,
          role: member.role,
        }));
        send(ctx, 200, { workspaces });
      },
    ],
    [
      'GET',
      '/api/workspaces/{id}',
      (ctx) => {
        const user = signedIn(ctx);
        const found = user && memberOf(ctx, user);
        if (!found) return;
        const { workspace, role } = found;
        const owner = role === 'owner';
        send(ctx, 200, {
          id: workspace.id,
          name: workspace.name,
          role,
          locked: workspace.locked,
          members: workspace.members
            .filter((m) => m.state === 'ACTIVE')
            .map((m) => {
              const u = state.user(m.handle);
              return { userId: u?.id ?? '', name: u?.displayName ?? m.handle, role: m.role };
            }),
          invites: owner
            ? workspace.invites
                .filter((i) => i.state === 'PENDING')
                .map((i) => ({ id: i.id, email: i.email, state: i.state }))
            : [],
          // The link and the code are the owner's to share; nobody else is told them.
          joinUrl: owner ? state.joinUrl(workspace) : null,
          joinCode: owner ? workspace.joinCode : null,
          documents: state.documentsIn(workspace).map((d) => ({
            id: d.id,
            title: d.title,
            uploadedBy: state.user(d.uploadedBy)?.displayName ?? d.uploadedBy,
          })),
        });
      },
    ],
    [
      'POST',
      '/api/workspaces/{id}/invites',
      (ctx) => {
        const user = signedIn(ctx);
        const found = user && memberOf(ctx, user);
        if (!found) return;
        if (found.role !== 'owner') return fail(ctx, 403, 'forbidden', 'Only the owner can invite people');
        const email = isRecord(ctx.body) && typeof ctx.body.email === 'string' ? ctx.body.email.trim() : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(ctx, 422, 'invalid', 'Enter an email address');
        const invite = state.invite(found.workspace, email);
        send(ctx, 200, {
          invite: { id: invite.id, email: invite.email, state: invite.state, expiresAt: invite.expiresAt },
        });
      },
    ],
    [
      'DELETE',
      '/api/workspaces/{id}/members/{userId}',
      (ctx) => {
        const user = signedIn(ctx);
        const found = user && memberOf(ctx, user);
        if (!found) return;
        if (found.role !== 'owner') return fail(ctx, 403, 'forbidden', 'Only the owner can remove people');
        const target = state.userById(ctx.params.userId ?? '');
        if (!target || !state.removeMember(found.workspace, target.handle))
          return fail(ctx, 404, 'not-found', 'Not a member');
        send(ctx, 200, { removed: true });
      },
    ],

    // -- documents and search -------------------------------------------------------------------------------------
    [
      'GET',
      '/api/documents/{id}',
      (ctx) => {
        const user = signedIn(ctx);
        if (!user) return;
        const doc = state.docs.get(Number(ctx.params.id));
        if (!doc || !state.canSee(user.handle, doc)) return fail(ctx, 404, 'not-found', 'Not found');
        const workspace = state.workspace(doc.workspaceId);
        send(ctx, 200, {
          id: doc.id,
          title: doc.title,
          workspaceId: doc.workspaceId,
          workspace: workspace?.name ?? '',
          uploadedBy: state.user(doc.uploadedBy)?.displayName ?? doc.uploadedBy,
        });
      },
    ],
    [
      'GET',
      '/api/search',
      (ctx) => {
        const user = signedIn(ctx);
        if (!user) return;
        const results = state.search(user.handle, ctx.url.searchParams.get('q') ?? '');
        send(ctx, 200, { results: results.map((d) => ({ id: d.id, title: d.title, workspaceId: d.workspaceId })) });
      },
    ],

    // -- join by link and code ------------------------------------------------------------------------------------
    [
      'GET',
      '/api/join/{token}',
      (ctx) => {
        const workspace = state.workspaceByToken(ctx.params.token ?? '');
        if (!workspace) return fail(ctx, 404, 'invalid-link', "This link isn't valid");
        send(ctx, 200, {
          workspace: workspace.name,
          owner: state.owner(workspace).firstName,
          locked: workspace.locked,
        });
      },
    ],
    [
      'POST',
      '/api/join/{token}',
      (ctx) => {
        const user = signedIn(ctx);
        if (!user) return;
        const workspace = state.workspaceByToken(ctx.params.token ?? '');
        if (!workspace) return fail(ctx, 404, 'invalid-link', "This link isn't valid");
        const code = isRecord(ctx.body) && typeof ctx.body.code === 'string' ? ctx.body.code.replace(/[\s-]/g, '') : '';
        const result = state.join(workspace, user.handle, code);
        if (result.ok) return send(ctx, 200, { workspace: { id: workspace.id, name: workspace.name } });
        const owner = state.owner(workspace).firstName;
        if (result.reason === 'locked')
          return fail(ctx, 423, 'locked', `Joining is locked. Ask ${owner} for a new link and code.`);
        if (result.reason === 'already-member')
          return fail(ctx, 409, 'already-member', `You're already in ${workspace.name}`);
        fail(ctx, 422, 'wrong-code', `That code doesn't match. ${result.triesLeft} tries left.`);
      },
    ],
  ];

  const compiled = routes.map(([method, path, handler]) => {
    const names: string[] = [];
    const regex = new RegExp(
      `^${path.replace(/\{(\w+)\}/g, (_, n: string) => {
        names.push(n);
        return '([^/]+)';
      })}$`,
    );
    return { method, regex, names, handler };
  });

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx: Ctx = { req, res, url, params: {}, body: undefined };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    for (const route of compiled) {
      const m = route.regex.exec(url.pathname);
      if (!m || route.method !== req.method) continue;
      route.names.forEach((n, i) => {
        ctx.params[n] = decodeURIComponent(m[i + 1] ?? '');
      });
      ctx.body = req.method === 'GET' ? undefined : await readBody(req);
      return route.handler(ctx);
    }
    fail(ctx, 404, 'not-found', 'Not found');
  };
}

function publicUser(user: User): Record<string, unknown> {
  return { userId: user.id, email: user.email, displayName: user.displayName, firstName: user.firstName };
}
