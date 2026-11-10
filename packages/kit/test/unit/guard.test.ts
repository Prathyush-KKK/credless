// The guard's rules for what WebKit and blob URLs report, judged on a stand-in browser context: a fetch a navigation
// cancelled is not counted twice, a framed PDF blob WebKit cannot show is listed, and a blob URL is printed once.
import { EventEmitter } from 'node:events';
import type { BrowserContext } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSignals } from '../../src/adapters/signals.ts';
import { hostPort } from '../../src/fixtures/egress.ts';
import { type AttachedGuard, attachGuard } from '../../src/fixtures/guard.ts';
import { keepOrSetTheme } from '../../src/fixtures/theme.ts';
import type { EgressPolicy } from '../../src/types.ts';

const APP = 'https://dev.app.example';
const API = 'https://dev.api.example';
const policy: EgressPolicy = {
  own: [hostPort(APP), hostPort(API)],
  thirdParty: [],
  analytics: [],
  production: { domains: ['example.com'], words: ['prod'], nonProductionPattern: '^dev\\.' },
  targetHosts: ['dev.app.example', 'dev.api.example'],
  allowPrivate: false,
};

/** What the guard listens to: a context and one page, both event emitters. */
function standIn() {
  const page = Object.assign(new EventEmitter(), {});
  const context = Object.assign(new EventEmitter(), {
    route: async () => undefined,
    routeWebSocket: async () => undefined,
    pages: () => [page],
  });
  return { page, context: context as unknown as BrowserContext & EventEmitter };
}

const request = (url: string, errorText: string) => ({
  url: () => url,
  method: () => 'GET',
  failure: () => ({ errorText }),
  redirectedFrom: () => null,
});

const consoleError = (text: string) => ({
  type: () => 'error',
  text: () => text,
  location: () => ({ url: `${APP}/app.js`, lineNumber: 1, columnNumber: 1 }),
});

let guard: AttachedGuard;
async function attach() {
  const { page, context } = standIn();
  guard = await attachGuard(context, {
    policy,
    appOrigins: [APP, API],
    apiOrigin: API,
    signals: defaultSignals(),
    label: 'a0.owner',
  });
  return { page, context };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the guard on what WebKit reports', () => {
  test("WebKit's console copy of a failed fetch is not a second violation; the request is judged once", async () => {
    const { page, context } = await attach();
    page.emit('console', consoleError('TypeError: Load failed'));
    expect(guard.violations).toEqual([]);
    context.emit('requestfailed', request(`${API}/v1/items`, 'Could not connect to the server.'));
    expect(guard.violations).toEqual([
      `[a0.owner] failed request: GET ${API}/v1/items (Could not connect to the server.)`,
    ]);
  });

  test('the "due to access control checks" page error for a fetch a navigation cancelled is dropped', async () => {
    vi.useFakeTimers();
    const { page, context } = await attach();
    // the page error can come first: it is held while the cancelled request has not been listed yet
    page.emit('pageerror', new Error(`Fetch API cannot load ${API}/v1/feed due to access control checks.`));
    expect(guard.violations).toHaveLength(1);
    context.emit('requestfailed', request(`${API}/v1/feed?page=2`, 'cancelled'));
    vi.advanceTimersByTime(2000);
    expect(guard.violations).toEqual([]);
    expect(guard.cancelled).toEqual([`GET ${API}/v1/feed`]);
    // and when the request was listed first, the copy never counts
    page.emit('pageerror', new Error(`Fetch API cannot load ${API}/v1/feed due to access control checks. (again)`));
    expect(guard.violations).toEqual([]);
  });

  test('the same page error stays a violation when no cancelled request explains it', async () => {
    vi.useFakeTimers();
    const { page } = await attach();
    page.emit('pageerror', new Error(`Fetch API cannot load ${API}/v1/secret-area due to access control checks.`));
    vi.advanceTimersByTime(2000);
    expect(guard.violations).toEqual([
      `[a0.owner] page error: Fetch API cannot load ${API}/v1/secret-area due to access control checks.`,
    ]);
  });

  test('a framed PDF blob WebKit cannot display is listed as cancelled, printed as blob:<url>, never failed', async () => {
    const { context } = await attach();
    context.emit('requestfailed', request(`blob:${APP}/5f0c6a0e-1d2b`, 'Frame load interrupted'));
    expect(guard.violations).toEqual([]);
    expect(guard.cancelled).toEqual([`GET blob:${APP}/5f0c6a0e-1d2b`]);
    // any other failure of a blob still fails, printed once
    context.emit('requestfailed', request(`blob:${APP}/77aa`, 'Load failed'));
    expect(guard.violations).toEqual([`[a0.owner] failed request: GET blob:${APP}/77aa (Load failed)`]);
  });
});

describe('the project theme', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  test('is stored when the browser has none, and a theme the test switched to survives the next page load', () => {
    const localStorage = storage();
    vi.stubGlobal('window', { localStorage });
    try {
      keepOrSetTheme('light');
      expect(localStorage.getItem('theme')).toBe('light');
      localStorage.setItem('theme', 'dark'); // the app's own toggle
      keepOrSetTheme('light'); // the init script on the reload
      expect(localStorage.getItem('theme')).toBe('dark');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('storage that throws leaves the page to prefers-color-scheme', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
      },
    });
    try {
      expect(() => keepOrSetTheme('dark')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
