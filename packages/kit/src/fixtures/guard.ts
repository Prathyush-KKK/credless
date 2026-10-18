// The guard every persona browser runs under.
//
// It fails the test on: a console error, an uncaught page error, a request that failed, an HTTP error from the app
// or the API, an unexpected sign-out (`AppSignals.unexpectedSignOut`), any request to production and any request to
// a host nobody listed. Analytics beacons are aborted before they leave (test traffic never reaches analytics), and
// the app's known third-party hosts are let through and listed. Exceptions are named, narrow and give a reason.
//
// Two layers: Playwright's route handler (requests the page makes) and the context's egress proxy (egress.ts),
// which also stops what the route handler never sees: redirect hops, WebSocket handshakes and context.request.
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from '@playwright/test';
import { redact } from '../core/secret.ts';
import type {
  AppSignals,
  EgressPolicy,
  EgressProxy,
  EgressVerdict,
  Guard,
  GuardKnobs,
  OutsideMode,
  SignalInput,
} from '../types.ts';
import { judgeEgress } from './egress.ts';

export interface NamedException {
  pattern: RegExp;
  reason: string;
}

/**
 * Console errors that are known and not the behaviour under test; each says why. A kit-wide list stays short: an
 * app adds its own through `GuardOptions.consoleExceptions`, a test through `guard.allowConsole()`.
 */
export const CONSOLE_EXCEPTIONS: readonly NamedException[] = [
  {
    // A report-only CSP header without report-to: a server header, not the app; WebKit logs it on every page.
    pattern:
      /^The Content Security Policy .* was delivered in report-only mode, but does not specify a 'report-(to|uri)'/s,
    reason: 'server header, not the app under test',
  },
];

interface Expected {
  url: RegExp;
  code: number;
}

/**
 * The run-wide knobs (the `guard` fixture): what one test expects from every session it opens. Each context's guard
 * reads these as well as its own.
 */
export class GuardKnobStore implements GuardKnobs {
  readonly expectedStatus: Expected[] = [];
  readonly expectedSignal: Expected[] = [];
  readonly consoleAllowed: NamedException[] = [];

  expectStatus(url: RegExp, status: number): void {
    this.expectedStatus.push({ url, code: status });
  }

  expectSignal(url: RegExp, code: number): void {
    this.expectedSignal.push({ url, code });
  }

  allowConsole(pattern: RegExp, reason: string): void {
    if (!reason) throw new Error('allowConsole needs a reason');
    this.consoleAllowed.push({ pattern, reason });
  }
}

export interface GuardOptions {
  /** the run's egress policy: own origins, host lists, production rules */
  policy: EgressPolicy;
  /** origins whose requests are the app's own: the web app, the API and the test API */
  appOrigins: string[];
  /** the API origin, whose answers are judged with the signals */
  apiOrigin: string;
  signals: AppSignals;
  /** whose browser this is, for messages: the handle */
  label: string;
  /** what to do with a request to an unlisted host: fail the test (default) or only list it */
  outside?: OutsideMode;
  /** the context's egress proxy: what it refuses is judged here like a refused request */
  egress?: Pick<EgressProxy, 'onRefused' | 'canarySeen'>;
  consoleExceptions?: readonly NamedException[];
  /** the test-wide knobs this context honours too */
  shared?: GuardKnobStore;
}

/** The frozen {@link Guard} plus what the fixture and the self-tests need. */
export interface AttachedGuard extends Guard {
  /** judge what Playwright buffered that a listener may have missed (console messages and page errors) */
  settle(): Promise<void>;
  /** for the kit's self-tests, which assert a violation and then prove the test still passes */
  clearViolations(): void;
}

/** How long the guard waits for a JSON body before judging an API answer on its status alone. */
const BODY_WAIT_MS = 1500;

async function jsonWithin(response: Response, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
    timer.unref?.();
  });
  try {
    return await Promise.race([response.json().catch(() => undefined), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(request: Request): string {
  const url = new URL(request.url());
  return `${request.method()} ${url.origin}${url.pathname}`;
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

/** Attach the guard to a persona's browser context (every page and popup in it). */
export async function attachGuard(context: BrowserContext, options: GuardOptions): Promise<AttachedGuard> {
  const appOrigins = new Set(options.appOrigins.map((o) => new URL(o).origin));
  const apiOrigin = new URL(options.apiOrigin).origin;
  const { policy, signals } = options;
  const outsideMode: OutsideMode = options.outside ?? 'fail';
  const own = new GuardKnobStore();
  const shared = options.shared;
  const consoleExceptions = options.consoleExceptions ?? CONSOLE_EXCEPTIONS;
  const aborted = new Set<string>();
  const judgedConsole = new Set<string>();
  const judgedErrors = new Set<string>();

  const violations: string[] = [];
  const outside: string[] = [];
  const thirdParty: string[] = [];
  const devHosts: string[] = [];
  const analyticsBlocked: string[] = [];
  const apiErrors: string[] = [];
  const cancelled: string[] = [];
  const violation = (text: string) => violations.push(redact(`[${options.label}] ${text}`));

  const expectedStatus = (url: string, status: number) =>
    [...own.expectedStatus, ...(shared?.expectedStatus ?? [])].some((e) => e.code === status && e.url.test(url));
  const expectedSignal = (url: string, code: number) =>
    [...own.expectedSignal, ...(shared?.expectedSignal ?? [])].some((e) => e.code === code && e.url.test(url));
  const consoleAllowed = (text: string) =>
    [...consoleExceptions, ...own.consoleAllowed, ...(shared?.consoleAllowed ?? [])].some((e) => e.pattern.test(text));

  const judge = (url: URL): EgressVerdict => judgeEgress(url.hostname, portOf(url), policy);

  await context.route('**/*', async (route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.continue();
    }
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (appOrigins.has(url.origin)) return route.continue();
    const verdict = judge(url);
    if (verdict === 'own' || verdict === 'canary') return route.continue();
    aborted.add(request.url());
    switch (verdict) {
      case 'prod':
        violation(`request to production refused: ${describe(request)}`);
        return route.abort('blockedbyclient');
      case 'analytics':
        analyticsBlocked.push(describe(request));
        return route.abort('blockedbyclient');
      case 'third-party':
        aborted.delete(request.url());
        thirdParty.push(describe(request));
        return route.continue();
      case 'dev':
        aborted.delete(request.url());
        devHosts.push(describe(request));
        return route.continue();
      default:
        if (outsideMode === 'note') outside.push(describe(request));
        else
          violation(
            `request to an unlisted host: ${describe(request)} (add it to hosts.thirdParty with a reason, or fix the app)`,
          );
        return route.abort('blockedbyclient');
    }
  });

  // WebSockets are not seen by context.route: allow only the run's own origins and the organisation's
  // non-production hosts, close anything else before it connects (the egress proxy would refuse it too).
  await context.routeWebSocket(/.*/, (ws) => {
    let target: URL | null = null;
    try {
      target = new URL(ws.url());
    } catch {
      target = null;
    }
    const verdict = target ? judge(target) : 'outside';
    if (verdict === 'own' || verdict === 'dev') {
      ws.connectToServer();
      return;
    }
    violation(`websocket refused: ${ws.url().split('?')[0]}`);
    ws.close({ code: 1008, reason: 'refused by the guard' }).catch(() => undefined);
  });

  // Redirect hops are not seen by context.route either: judge every request the browser actually makes. A hop to
  // production or an unlisted host fails the test (the cookies are host-only for the run's hosts, so none rode along).
  context.on('request', (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (!/^(https?|wss?):$/.test(url.protocol) || appOrigins.has(url.origin)) return;
    const hop = request.redirectedFrom();
    if (!hop) return; // first hops went through the route handler above
    const verdict = judge(url);
    if (verdict === 'own' || verdict === 'third-party' || verdict === 'dev') return;
    // The egress proxy refuses the hop (no connection is made); its failure is this line, not a second one.
    aborted.add(request.url());
    const line = `${describe(hop)} -> ${url.origin}${url.pathname}`;
    if (verdict === 'prod') violation(`redirect to production: ${line}`);
    else if (outsideMode === 'note') outside.push(`redirect: ${line}`);
    else violation(`redirect to an unlisted host: ${line}`);
  });

  options.egress?.onRefused(({ verdict, line }) => {
    switch (verdict) {
      case 'canary':
        return;
      case 'analytics':
        analyticsBlocked.push(`egress proxy: ${line}`);
        return;
      case 'prod':
        violation(`production refused by the egress proxy: ${line}`);
        return;
      case 'private':
        violation(`a private address refused by the egress proxy: ${line}`);
        return;
      default:
        if (outsideMode === 'note') outside.push(`egress proxy: ${line}`);
        else violation(`egress proxy refused an unlisted host: ${line}`);
    }
  });

  const consoleKey = (message: ConsoleMessage) => {
    const at = message.location();
    return `${message.type()}|${message.text()}|${at.url}:${at.lineNumber}:${at.columnNumber}`;
  };
  const judgeConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const key = consoleKey(message);
    if (judgedConsole.has(key)) return;
    judgedConsole.add(key);
    const text = message.text();
    const source = message.location().url ?? '';
    // The browser's own line for a request this guard aborted (the request itself was judged above).
    if (
      /^Failed to load resource/.test(text) &&
      (aborted.has(source) || [...aborted].some((u) => u.split('?')[0] === source.split('?')[0]))
    ) {
      return;
    }
    // The browser's line for an HTTP error from the app or the API: the response handler judges those (and knows
    // which statuses the test expects), so the console copy would only count it twice.
    if (/^Failed to load resource: the server responded with a status of \d{3}/.test(text)) {
      try {
        if (appOrigins.has(new URL(source).origin)) return;
      } catch {
        // no source URL: judge the line below
      }
    }
    if (/net::ERR_BLOCKED_BY_CLIENT/.test(text)) return;
    if (consoleAllowed(text)) return;
    const first = text.split('\n')[0] ?? '';
    violation(`console error: ${first.length > 300 ? `${first.slice(0, 160)} ... ${first.slice(-120)}` : first}`);
  };
  const judgePageError = (error: Error) => {
    const key = `${error.name}|${error.message}|${error.stack ?? ''}`;
    if (judgedErrors.has(key)) return;
    judgedErrors.add(key);
    violation(`page error: ${error.message.split('\n')[0]}`);
  };

  const watch = (page: Page) => {
    page.on('pageerror', judgePageError);
    page.on('console', judgeConsole);
  };
  context.pages().forEach(watch);
  context.on('page', watch);

  context.on('requestfailed', (request) => {
    if (aborted.has(request.url())) return;
    const failure = request.failure()?.errorText ?? 'unknown';
    // A navigation (often the test's own goto or reload) cancels requests still in flight: listed, not a failure.
    // Real network failures (refused, DNS, TLS, timeouts) still fail the test.
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled/i.test(failure)) {
      cancelled.push(describe(request));
      return;
    }
    violation(`failed request: ${describe(request)} (${failure})`);
  });

  context.on('response', async (response: Response) => {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (!appOrigins.has(url.origin)) return;
    const status = response.status();
    const isApi = url.origin === apiOrigin;
    const line = describe(response.request());
    // The signals may read an envelope, but a body the page never consumes may never finish loading: wait a
    // bounded time for it and judge on the status alone after that.
    const json =
      isApi && (response.headers()['content-type'] ?? '').includes('json')
        ? await jsonWithin(response, BODY_WAIT_MS)
        : undefined;
    const input: SignalInput = { url, status, json };
    const code = isApi ? signals.apiError(input) : null;
    const signalExpected = code !== null && expectedSignal(response.url(), code);
    // An expected signal whose code is the HTTP status (the default signals) covers the status too.
    if (status >= 400 && !expectedStatus(response.url(), status) && !(signalExpected && code === status)) {
      violation(`HTTP ${status}: ${line}`);
    }
    if (!isApi) return;
    if (code !== null && !signalExpected) apiErrors.push(redact(`${line} -> code ${code}`));
    if (signals.unexpectedSignOut(input) && !signalExpected) {
      violation(`the session ended unexpectedly (${code ?? status}): ${line}`);
    }
  });

  const settle = async () => {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const [messages, errors] = await Promise.all([
        page.consoleMessages().catch(() => [] as ConsoleMessage[]),
        page.pageErrors().catch(() => [] as Error[]),
      ]);
      messages.forEach(judgeConsole);
      errors.forEach(judgePageError);
    }
  };

  return {
    label: options.label,
    violations,
    outside,
    thirdParty,
    devHosts,
    analyticsBlocked,
    apiErrors,
    cancelled,
    get canarySeen() {
      return options.egress?.canarySeen ?? false;
    },
    expectStatus: (url, status) => own.expectStatus(url, status),
    expectSignal: (url, code) => own.expectSignal(url, code),
    allowConsole: (pattern, reason) => own.allowConsole(pattern, reason),
    settle,
    clearViolations: () => {
      violations.length = 0;
    },
  };
}
