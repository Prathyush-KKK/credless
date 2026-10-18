// `<kit>/server` (plan §5): `createTestApi()`, the core contract handler a Node backend mounts under the base path.
//
// One function, no framework: the host app calls the returned handler first in its own request listener and
// carries on when it answers false (the path is not under the base path). Everything HTTP lives here: the
// constant-time key check, the route table, JSON bodies, the `{ error: { code, message } }` refusals and the
// `Set-Cookie` of `/session`. Everything about the app's state is behind `TestApiServerOptions`, so a backend
// implements seven small functions and gets the contract. The demo app (apps/demo/src/test-api.ts) is the reference
// use, extension routes included.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CORE_ROUTES,
  DEFAULTS,
  type HttpMethod,
  PATTERNS,
  type RouteDef,
  type RouteTable,
  type TestApiHandler,
  type TestApiServerOptions,
} from '../types.ts';

export type {
  ApiErrorBody,
  CleanupRunRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  Health,
  MintedSession,
  PersonaRef,
  PersonaSpec,
  PersonaState,
  ResetResult,
  TestApiHandler,
  TestApiServerOptions,
  WireMessage,
} from '../types.ts';
export { CORE_ROUTES, DEFAULTS } from '../types.ts';

/** What an extension route's handler receives. `body` is the parsed JSON body (undefined when there is none). */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** `{param}` values of the route path, URL-decoded */
  params: Record<string, string>;
  body: unknown;
  /** first 8 hex of SHA-256 of the key that was presented, for the app's own audit line */
  keyId: string;
}

/** Answer with a 200 JSON body by returning a value, or with a status and headers by returning a {@link Reply}. */
export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

/** One app route under the base path: the contract's operationId, method, path and handler. */
export interface ExtensionRoute extends RouteDef {
  operationId: string;
  handler: RouteHandler;
}

/** A refusal: the HTTP status and the stable code the contract's `Error` schema carries. Thrown by handlers. */
export class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.code = code;
  }
}

/** Throw a {@link Refusal}; a handler's one-liner for `return refuse(404, 'not-found', ...)`. */
export function refuse(status: number, code: string, message: string): never {
  throw new Refusal(status, code, message);
}

/** A handler's answer when it needs more than a 200 JSON body: a status and headers (`Set-Cookie`). */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string | string[]>;
  constructor(status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** The handler plus the hook for an app's own routes. `extend` returns the same handler, so calls chain. */
export interface TestApiServer extends TestApiHandler {
  readonly basePath: string;
  /** core routes plus every extension route, keyed by operationId (what `health.extensions` and the broker read) */
  readonly routes: RouteTable;
  extend(routes: ExtensionRoute[]): TestApiServer;
}

interface Compiled {
  operationId: string;
  method: HttpMethod;
  regex: RegExp;
  names: string[];
  handler: RouteHandler;
}

const MAX_BODY_BYTES = 1024 * 1024;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function compile(operationId: string, route: RouteDef, handler: RouteHandler): Compiled {
  const names: string[] = [];
  const pattern = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { operationId, method: route.method, regex: new RegExp(`^${pattern}$`), names, handler };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) refuse(422, 'invalid', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return refuse(422, 'invalid', 'request body is not JSON');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHandle = (v: unknown): v is string => typeof v === 'string' && PATTERNS.handle.test(v);

function handleList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64) refuse(422, 'invalid', `${field} must list 1 to 64 entries`);
  for (const h of v) if (!isHandle(h)) refuse(422, 'invalid', `${field}: not a handle`);
  return v as string[];
}

function intQuery(url: URL, name: string, min: number, max: number, fallback?: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    refuse(422, 'invalid', `${name} must be an integer in ${min}..${max}`);
  return n;
}

/**
 * The core contract handler. Mount it under `basePath` on the api origin; it answers every request under that path
 * (true) and leaves the rest to the app (false). The key is compared in constant time on every route, before the
 * route is even looked up, so an unauthenticated caller cannot tell which routes exist.
 */
export function createTestApi(options: TestApiServerOptions): TestApiServer {
  const basePath = (options.basePath ?? DEFAULTS.basePath).replace(/\/$/, '');
  const keyHeader = (options.keyHeader ?? DEFAULTS.keyHeader).toLowerCase();
  const keyDigest = sha256(typeof options.key === 'string' ? options.key : options.key.reveal());
  const isTest = options.isTestAccount ?? (async () => true);
  const routes: Record<string, RouteDef> = { ...CORE_ROUTES };
  const extensions = new Set(options.extensions ?? []);

  /** The handle exists (404 otherwise) and is a test account (403 otherwise): lock 4 of the brief, on every object. */
  async function testAccount(handle: string) {
    const state = await options.personas.state(handle);
    if (!state) refuse(404, 'not-found', 'no such test account');
    if (!(await isTest(handle))) refuse(403, 'not-test-account', 'not a test account');
    return state;
  }

  const core: Record<keyof typeof CORE_ROUTES, RouteHandler> = {
    health: ({ keyId }) => ({
      enabled: true,
      environment: options.environment,
      keyId,
      ...(options.version ? { version: options.version } : {}),
      sinks: options.sinks ?? {},
      extensions: [...extensions],
    }),

    async ensurePersonas({ body }) {
      const list = isRecord(body) ? body.personas : undefined;
      if (!Array.isArray(list) || list.length < 1 || list.length > 64) {
        refuse(422, 'invalid', 'personas must list 1 to 64 entries');
      }
      for (const spec of list) {
        if (!isRecord(spec) || !isHandle(spec.handle)) refuse(422, 'invalid', 'persona: handle is not a handle');
        if (typeof spec.email !== 'string' || typeof spec.displayName !== 'string' || spec.displayName.length > 80) {
          refuse(422, 'invalid', `persona ${spec.handle}: email and displayName are required`);
        }
        if (!isRecord(spec.attributes)) refuse(422, 'invalid', `persona ${spec.handle}: attributes must be an object`);
        if (!options.addressPattern.test(spec.email)) {
          refuse(403, 'address-outside-range', `persona ${spec.handle}: address outside the test range`);
        }
      }
      return { personas: await options.personas.ensure(list) };
    },

    async resetPersonas({ body }) {
      const list = handleList(isRecord(body) ? body.handles : undefined, 'handles');
      for (const handle of list) await testAccount(handle);
      return { reset: await options.personas.reset(list) };
    },

    personaState: ({ params }) => testAccount(params.handle ?? ''),

    async createSession({ body }) {
      if (!isRecord(body) || !isHandle(body.handle)) refuse(422, 'invalid', 'handle is required');
      if (typeof body.runId !== 'string' || !PATTERNS.runId.test(body.runId))
        refuse(422, 'invalid', 'runId is required');
      if (body.client !== undefined && typeof body.client !== 'string')
        refuse(422, 'invalid', 'client must be a string');
      await testAccount(body.handle);
      const minted = await options.session.mint({
        handle: body.handle,
        runId: body.runId,
        client: body.client ?? 'web',
      });
      return new Reply(200, { user: minted.user, expiresAt: minted.expiresAt }, { 'Set-Cookie': minted.setCookies });
    },

    async personaMessages({ params, url }) {
      const handle = params.handle ?? '';
      await testAccount(handle);
      const kind = url.searchParams.get('kind') ?? undefined;
      if (kind !== undefined && kind.length > 32) refuse(422, 'invalid', 'kind is too long');
      const since = intQuery(url, 'since', 0, Number.MAX_SAFE_INTEGER);
      const limit = intQuery(url, 'limit', 1, 50, 10);
      return { messages: await options.mail.list(handle, { since, kind, limit }) };
    },

    async cleanupRun({ params, body }) {
      const runId = params.runId ?? '';
      if (!PATTERNS.runId.test(runId)) refuse(422, 'invalid', 'runId does not match the run id shape');
      const revokeField = isRecord(body) ? body.revokeSessions : undefined;
      if (body !== undefined && (!isRecord(body) || (revokeField !== undefined && typeof revokeField !== 'boolean'))) {
        refuse(422, 'invalid', 'revokeSessions must be a boolean');
      }
      const removed = await options.cleanup(runId);
      const sessionsRevoked = revokeField === false ? 0 : await options.session.revoke(runId);
      return { removed, sessionsRevoked };
    },
  };

  const compiled: Compiled[] = (Object.keys(CORE_ROUTES) as Array<keyof typeof CORE_ROUTES>).map((id) =>
    compile(id, CORE_ROUTES[id], core[id]),
  );

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  const handler = (async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
    try {
      const presented = req.headers[keyHeader];
      const digest = sha256(typeof presented === 'string' ? presented : '');
      if (typeof presented !== 'string' || !timingSafeEqual(digest, keyDigest)) {
        refuse(401, 'bad-key', 'missing or wrong runner key');
      }
      const keyId = digest.toString('hex').slice(0, 8);
      const relative = url.pathname.slice(basePath.length) || '/';
      const route = compiled.find((r) => r.method === req.method && r.regex.test(relative));
      if (!route) refuse(404, 'not-found', 'no such route under the test API');
      const match = route.regex.exec(relative) ?? [];
      const params: Record<string, string> = {};
      route.names.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? '');
      });
      const body = req.method === 'GET' ? undefined : await readJson(req);
      const answer = await route.handler({ req, res, url, params, body, keyId });
      if (answer instanceof Reply) send(res, answer.status, answer.body, answer.headers);
      else send(res, 200, answer ?? null);
    } catch (error) {
      if (error instanceof Refusal) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        // The app's bug, not the caller's; its message could quote a header, so the caller gets a generic one.
        console.error('test API:', error instanceof Error ? error.stack : error);
        send(res, 500, { error: { code: 'internal', message: 'the test API failed; see the server log' } });
      }
    }
    return true;
  }) as TestApiServer;

  Object.defineProperties(handler, {
    basePath: { value: basePath, enumerable: true },
    routes: { get: () => ({ ...routes }), enumerable: true },
    extend: {
      value(more: ExtensionRoute[]): TestApiServer {
        for (const route of more) {
          routes[route.operationId] = { method: route.method, path: route.path };
          extensions.add(route.operationId);
          compiled.push(compile(route.operationId, route, route.handler));
        }
        return handler;
      },
    },
  });
  return handler;
}
