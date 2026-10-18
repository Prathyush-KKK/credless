// Stand-in for src/core/test-api-client.ts (Task 1): the low-level client that puts the key (direct) or the token
// (broker) on the wire. Plain JSON, no envelope, `{ error: { code, message } }` on refusals, never follows redirects.
import {
  type CallLogEntry,
  type CallRequest,
  type CallResult,
  DEFAULTS,
  type RouteTable,
  type TestApiClient as TestApiClientShape,
  type TestApiError as TestApiErrorShape,
  type Transport,
} from '../../types.ts';

export interface TestApiClientOptions {
  apiOrigin: string;
  transport: Transport;
  routes: RouteTable;
  basePath?: string;
  keyHeader?: string;
  headers?: Record<string, string>;
}

export class TestApiError extends Error implements TestApiErrorShape {
  override readonly name = 'TestApiError' as const;
  readonly operationId: string;
  readonly http: number;
  readonly code: string | null;
  readonly notFound: boolean;

  constructor(operationId: string, http: number, code: string | null, message: string) {
    super(`${operationId}: HTTP ${http}${code ? ` (${code})` : ''}: ${message}`);
    this.operationId = operationId;
    this.http = http;
    this.code = code;
    this.notFound = http === 404;
  }
}

export class TestApiClient implements TestApiClientShape {
  readonly apiOrigin: string;
  readonly basePath: string;
  readonly routes: RouteTable;
  readonly log: CallLogEntry[] = [];
  readonly #transport: Transport;
  readonly #keyHeader: string;
  readonly #headers: Record<string, string>;

  constructor(options: TestApiClientOptions) {
    this.#transport = options.transport;
    this.apiOrigin = (options.transport.kind === 'broker' ? options.transport.url : options.apiOrigin).replace(
      /\/+$/,
      '',
    );
    this.basePath = options.basePath ?? DEFAULTS.basePath;
    this.routes = options.routes;
    this.#keyHeader = options.keyHeader ?? DEFAULTS.keyHeader;
    this.#headers = options.headers ?? {};
  }

  async call<T = unknown>(operationId: string, request: CallRequest = {}): Promise<CallResult<T>> {
    const route = this.routes[operationId];
    if (!route) throw new Error(`not a contract route: ${operationId}`);
    let pathname = route.path.replace(/\{(\w+)\}/g, (_m, name: string) =>
      encodeURIComponent(String(request.params?.[name] ?? '')),
    );
    const query = Object.entries(request.query ?? {}).filter((e): e is [string, string | number] => e[1] !== undefined);
    if (query.length) pathname += `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)])).toString()}`;
    const headers: Record<string, string> = { accept: 'application/json', ...this.#headers, ...request.headers };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (this.#transport.kind === 'direct') headers[this.#keyHeader] = this.#transport.key.reveal();
    else headers[DEFAULTS.brokerTokenHeader] = this.#transport.token.reveal();
    const started = Date.now();
    const entry: CallLogEntry = {
      at: new Date().toISOString(),
      method: route.method,
      path: pathname,
      status: 'error',
      ms: 0,
    };
    this.log.push(entry);
    let res: Response;
    try {
      res = await fetch(`${this.apiOrigin}${this.basePath}${pathname}`, {
        method: route.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      });
    } catch (error) {
      entry.ms = Date.now() - started;
      // Rebuilt from scratch: the original could quote the request (and its headers).
      throw new TestApiError(operationId, 0, null, `request failed: ${(error as Error).name}`);
    }
    entry.ms = Date.now() - started;
    entry.status = res.status;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new TestApiError(operationId, res.status, err?.code ?? null, err?.message ?? 'refused');
    }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { http: res.status, data: data as T, setCookies };
  }
}
