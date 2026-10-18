// N01: under the worker shim a `fetch()` from a worker to anything but loopback is refused before a connection is
// attempted, and loopback still works. The shim is loaded the way a run loads it (`--import`) into a child Node
// process; the destination is TEST-NET-1 (192.0.2.1), which never answers, so a refusal that comes back at once
// can only be the shim's.
// biome-ignore lint/style/noRestrictedImports: this self-test drives Node child processes on purpose
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const shim = fileURLToPath(new URL('../../src/runner/worker-shim.ts', import.meta.url));
const node = globalThis.process;

const PROBE = `
const started = Date.now();
const outcome = { fetch: null, net: null, local: null, ms: 0 };
try {
  await fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(5000) });
  outcome.fetch = 'connected';
} catch (error) {
  outcome.fetch = String(error?.cause?.message ?? error?.message);
}
outcome.ms = Date.now() - started;
const net = await import('node:net');
outcome.net = await new Promise((resolve) => {
  const s = net.connect(80, '192.0.2.1');
  s.once('error', (e) => resolve(e.message));
  s.once('connect', () => resolve('connected'));
});
const http = await import('node:http');
const server = http.createServer((req, res) => res.end('hello'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
outcome.local = await (await fetch('http://127.0.0.1:' + port + '/')).text();
server.close();
console.log(JSON.stringify(outcome));
`;

test.describe('worker shim', () => {
  test('N01 fetch() and net.connect() to a non-loopback host are refused before connecting; loopback works', () => {
    const result = spawnSync(
      node.execPath,
      ['--import', pathToFileURL(shim).href, '--input-type=module', '-e', PROBE],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: node.env.PATH, CREDLESS_WORKER_PROXY_URL: 'loopback' },
        cwd: path.dirname(shim),
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as {
      fetch: string;
      net: string;
      local: string;
      ms: number;
    };
    expect(outcome.fetch).toContain('worker shim: refused 192.0.2.1:80');
    expect(outcome.net).toContain('worker shim: refused 192.0.2.1:80');
    expect(outcome.ms, 'refused before any connection attempt').toBeLessThan(2_000);
    expect(outcome.local).toBe('hello');
    expect(result.stderr).toContain('credless worker shim: refused 192.0.2.1:80');
  });

  test('N01b with the variable unset the shim is inert (loopback works, nothing is logged)', () => {
    const inert = `
const http = await import('node:http');
const server = http.createServer((req, res) => res.end('hello'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
console.log(await (await fetch('http://127.0.0.1:' + server.address().port + '/')).text());
server.close();
`;
    const result = spawnSync(
      node.execPath,
      ['--import', pathToFileURL(shim).href, '--input-type=module', '-e', inert],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: node.env.PATH },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).not.toContain('worker shim');
  });
});
