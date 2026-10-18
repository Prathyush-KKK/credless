// Starts the demo: the web app and the api (with the test API under /_test) on loopback, plus the two sentinels the
// kit's self-tests count leaks on. Prints one line once everything listens:
//   ready web=http://127.0.0.1:<p> api=http://127.0.0.1:<q>
// which Playwright's `webServer.wait` regex reads (docs/conventions.md §10).
//
//   node apps/demo/src/server.ts [--web-port N] [--api-port N] [--write-key PATH] [--no-sentinels] [--no-test-api]
//
// The runner key the demo expects is a stand-in, never a real secret: it is generated and written (mode 0600, never
// overwriting) to `--write-key PATH` so the kit's `selftest` and `demo` targets read it from the same file, or comes
// from the file named by CREDLESS_DEMO_KEY_FILE, or falls back to apps/demo/src/fake-secrets.json.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppApi, SENTINEL_HTTP } from './api.ts';
import fakeSecrets from './fake-secrets.json' with { type: 'json' };
import { DemoState } from './state.ts';
import { createDemoTestApi } from './test-api.ts';

const KEY_FILE_ENV = 'CREDLESS_DEMO_KEY_FILE';
const TEST_API_BASE = '/_test';

interface Args {
  webPort: number;
  apiPort: number;
  writeKey: string | null;
  sentinels: boolean;
  testApi: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { webPort: 0, apiPort: 0, writeKey: null, sentinels: true, testApi: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === '--web-port') args.webPort = Number(value());
    else if (flag === '--api-port') args.apiPort = Number(value());
    else if (flag === '--write-key') args.writeKey = value();
    else if (flag === '--no-sentinels') args.sentinels = false;
    else if (flag === '--no-test-api') args.testApi = false;
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        'usage: node server.ts [--web-port N] [--api-port N] [--write-key PATH] [--no-sentinels] [--no-test-api]\n',
      );
      process.exit(0);
    } else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** The runner key, by source: a fresh one written to `--write-key`, the env-named file, or the stand-in. */
function resolveKey(args: Args): string {
  // The flag first: a harness that asks for a fresh key says so on the command line, while the variable it sets for
  // its own processes (the config's `file` key source) is inherited by this one too.
  if (args.writeKey) {
    const key = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(args.writeKey), { recursive: true, mode: 0o700 });
    // O_EXCL: a stale file is the caller's to remove; the demo never overwrites a key file it did not create.
    fs.writeFileSync(args.writeKey, key, { mode: 0o600, flag: 'wx' });
    return key;
  }
  const fromEnv = process.env[KEY_FILE_ENV];
  if (fromEnv) {
    const key = fs.readFileSync(fromEnv, 'utf8').trim();
    if (!key) throw new Error(`${KEY_FILE_ENV} names an empty file`);
    return key;
  }
  return fakeSecrets.runnerKey;
}

function listen(server: http.Server | dgram.Socket, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (server instanceof http.Server) {
      server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    } else {
      server.bind(port, '127.0.0.1', () => resolve(server.address().port));
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const key = resolveKey(args);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appHtml = fs.readFileSync(path.join(here, 'app.html'), 'utf8');

  // The web origin is known only once the web server listens; the state needs it for join links, so it is set
  // before any request is served.
  const state = new DemoState({ webOrigin: 'http://127.0.0.1', signinPassword: fakeSecrets.signinPassword });
  const appApi = createAppApi(state);
  const testApi = args.testApi ? createDemoTestApi(state, { key, basePath: TEST_API_BASE }) : null;

  const api = http.createServer(async (req, res) => {
    try {
      // The flag-off case of the brief: without the test API the base path is as unknown as any other (plain 404).
      if (testApi && (await testApi(req, res))) return;
      await appApi(req, res);
    } catch (error) {
      console.error('api:', error instanceof Error ? error.stack : error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: 'the demo api failed; see the server log' } }));
    }
  });

  // Sentinels: a host the guard must never let a persona reach. Anything arriving is a leak; the counts are read
  // through /__demo/sentinel on the web origin. UDP catches STUN/TURN from WebRTC, which no HTTP proxy sees.
  let sentinelHits = 0;
  let sentinelDatagrams = 0;
  const sentinel = http.createServer((req, res) => {
    sentinelHits += 1;
    if (req.headers.upgrade) return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('sentinel: you should not be here');
  });
  sentinel.on('upgrade', (_req, socket) => {
    sentinelHits += 1;
    socket.destroy();
  });
  const udpSentinel = dgram.createSocket('udp4');
  udpSentinel.on('message', () => {
    sentinelDatagrams += 1;
  });

  let apiOrigin = '';
  const web = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    // Redirects out of the app, for the guard and egress self-tests: to an unlisted but reachable loopback port, and
    // to a production-shaped host (by the word rule) that does not exist.
    if (url.pathname === '/__demo/redirect-out') {
      res.writeHead(302, { Location: `${SENTINEL_HTTP}/landing` });
      return res.end();
    }
    if (url.pathname === '/__demo/redirect-prod') {
      res.writeHead(302, { Location: 'https://app.prod.example/j/abc' });
      return res.end();
    }
    if (url.pathname === '/__demo/sentinel') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ hits: sentinelHits, datagrams: sentinelDatagrams }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(appHtml.replace('__API_ORIGIN__', apiOrigin));
  });

  const apiPort = await listen(api, args.apiPort);
  apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webPort = await listen(web, args.webPort);
  state.webOrigin = `http://127.0.0.1:${webPort}`;
  if (args.sentinels) {
    // A second demo on the same machine finds the fixed ports taken; it runs without sentinels and says so.
    const bound = await Promise.allSettled([listen(sentinel, 4319), listen(udpSentinel, 3478)]);
    for (const [i, result] of bound.entries()) {
      if (result.status === 'rejected') {
        console.error(
          `demo: ${i === 0 ? 'TCP sentinel 4319' : 'UDP sentinel 3478'} not bound (${(result.reason as Error).message}); leak counts stay 0`,
        );
      }
    }
  }
  process.stdout.write(`ready web=${state.webOrigin} api=${apiOrigin}\n`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    api.close();
    web.close();
    sentinel.close();
    try {
      udpSentinel.close();
    } catch {
      // never bound
    }
    api.closeAllConnections();
    web.closeAllConnections();
    sentinel.closeAllConnections();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(`demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
