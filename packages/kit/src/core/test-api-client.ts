// The low-level test-API client. Only this file puts the runner key or the broker token on the wire, and it never
// puts either anywhere else: errors are rebuilt from scratch and redacted, and the call log keeps method, path,
// status and time only.
import {
  type ApiErrorBody,
  type CallLogEntry,
  type CallRequest,
  type CallResult,
  CORE_ROUTES,
  DEFAULTS,
  type RouteTable,
  type TestApiClient as TestApiClientShape,
  type TestApiError as TestApiErrorShape,
  type Transport,
} from '../types.ts';
import { fillPath } from './routes.ts';
import { redact, registerSecretValue, sanitizedError } from './secret.ts';

/** The error the client throws: redacted message, no header and no body, so it can be printed anywhere. */
export class TestApiError extends Error implements TestApiErrorShape {
  override readonly name = 'TestApiError' as const;
  readonly operationId: string;
  readonly http: number;
  readonly code: string | null;

  constructor(operationId: string, http: number, code: string | null, message: string) {
    super(redact(message));
    this.operationId = operationId;
    this.http = http;
    this.code = code;
  }

  /** HTTP 404: the object is gone, or the route is not registered (the test API is off on this target). */
  get notFound(): boolean {
    return this.http === 404;
  }
}

export interface TestApiClientOptions {
  /** the origin that serves the test API (`endpoints.testApi`), as the browser sees it (cookie domains, messages) */
  apiOrigin: string;
  /** default {@link DEFAULTS.basePath} */
  basePath?: string;
  /** default {@link CORE_ROUTES}; core plus the app's routes for an extended control */
  routes?: RouteTable;
  transport: Transport;
  /** default {@link DEFAULTS.keyHeader} (`testApi.keyHeader`) */
  keyHeader?: string;
  /** headers sent on every call (`testApi.headers`) */
  headers?: Record<string, string>;
  /** default 30 000 */
  timeoutMs?: number;
  /** injected in tests */
  fetchImpl?: typeof fetch;
}

function errorBody(parsed: unknown): ApiErrorBody['error'] | null {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return null;
  const error = (parsed as { error: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' ? { code, message: typeof message === 'string' ? message : '' } : null;
}

export class TestApiClient implements TestApiClientShape {
  readonly apiOrigin: string;
  readonly basePath: string;
  readonly routes: RouteTable;
  readonly log: CallLogEntry[] = [];
  readonly #transport: Transport;
  readonly #keyHeader: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: TestApiClientOptions) {
    this.apiOrigin = new URL(options.apiOrigin).origin;
    this.basePath = (options.basePath ?? DEFAULTS.basePath).replace(/\/+$/, '');
    this.routes = options.routes ?? CORE_ROUTES;
    this.#transport = options.transport;
    this.#keyHeader = options.keyHeader ?? DEFAULTS.keyHeader;
    this.#headers = { ...(options.headers ?? {}) };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** `direct` or `broker`; never the key or the token. */
  get transportKind(): Transport['kind'] {
    return this.#transport.kind;
  }

  async call<T = unknown>(operationId: string, request: CallRequest = {}): Promise<CallResult<T>> {
    const route = this.routes[operationId];
    if (!route) throw new Error(`no test API route ${operationId} (have: ${Object.keys(this.routes).join(', ')})`);
    const { method } = route;
    const pathname = `${this.basePath}${fillPath(route.path, request.params)}`;
    const transport = this.#transport;
    const url = new URL(pathname, transport.kind === 'broker' ? transport.url : this.apiOrigin);
    for (const [k, v] of Object.entries(request.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.#headers,
      ...(request.headers ?? {}),
    };
    if (transport.kind === 'direct') headers[this.#keyHeader] = transport.key.reveal();
    else headers[DEFAULTS.brokerTokenHeader] = transport.token.reveal();
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';

    const started = Date.now();
    const entry: CallLogEntry = {
      at: new Date(started).toISOString(),
      method,
      path: url.pathname,
      status: 'error',
      ms: 0,
    };
    this.log.push(entry);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs),
      });
    } catch (error) {
      entry.ms = Date.now() - started;
      // the cause can list request headers: keep one redacted line, as a TestApiError without a status
      const clean = sanitizedError(error, `test API ${method} ${url.pathname} failed before a response`);
      throw new TestApiError(operationId, 0, null, clean.message);
    }
    entry.status = response.status;
    entry.ms = Date.now() - started;

    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of setCookies) registerSecretValue(cookie.split(';')[0]?.split('=').slice(1).join('='));

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (response.status < 200 || response.status >= 300) {
      const error = errorBody(parsed);
      const why = error
        ? ` (${error.code}${error.message ? `: ${error.message}` : ''})`
        : response.status === 404
          ? ' (route not found: is the test API on for this target?)'
          : '';
      throw new TestApiError(
        operationId,
        response.status,
        error?.code ?? null,
        `test API ${method} ${url.pathname} -> HTTP ${response.status}${why}`,
      );
    }
    return { http: response.status, data: parsed as T, setCookies };
  }
}
