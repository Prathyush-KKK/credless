// U12: resolve once, refuse private answers on a remote target, dial the first address and pin it; the limits.
// Drives the real proxy with plain Node sockets: a CONNECT tunnel and an absolute-form request.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { CANARY_HOST } from '../../src/brand.ts';
import { type KitEgressProxy, resolveAndPin, startEgressProxy } from '../../src/fixtures/egress.ts';
import type { EgressLimits, EgressPolicy, HostResolver, ResolvedAddress } from '../../src/types.ts';

const HOST = 'dev.app.example';

interface Listener {
  port: number;
  hits: string[];
  close(): Promise<void>;
}

/** A tiny origin that records the Host header of every request; `null` when the address cannot be bound here. */
async function origin(address: string, name: string): Promise<Listener | null> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${name} ${req.method} ${req.url} host=${req.headers.host}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(name);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, address, () => resolve());
    });
  } catch {
    return null;
  }
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function policyFor(port: number, allowPrivate: boolean): EgressPolicy {
  return {
    own: [`${HOST}:${port}`],
    thirdParty: [],
    analytics: [],
    production: { domains: ['example.com'], words: ['prod', 'production'] },
    targetHosts: [HOST],
    allowPrivate,
  };
}

/** One request through the proxy in absolute form; returns the status line and body. */
function viaProxy(
  proxyUrl: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: url,
        headers: { host: new URL(url).host, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A CONNECT tunnel to host:port through the proxy; resolves with the proxy's status and the open socket. */
function tunnel(proxyUrl: string, authority: string): Promise<{ status: number; socket: net.Socket }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once('data', (chunk) => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1] ?? 0);
      resolve({ status, socket });
    });
    socket.once('error', reject);
  });
}

/** Speak HTTP/1.1 inside an established tunnel. */
function insideTunnel(socket: net.Socket, host: string, path: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    socket.on('data', (chunk) => {
      out += chunk;
      if (/\r\n\r\n[\s\S]*$/.test(out) && /content-length: (\d+)/i.test(out)) {
        const length = Number(/content-length: (\d+)/i.exec(out)?.[1]);
        if (out.split('\r\n\r\n')[1]?.length === length) resolve(out);
      }
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    socket.once('close', () => resolve(out));
  });
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function proxyWith(policy: EgressPolicy, lookup: HostResolver, limits?: Partial<EgressLimits>) {
  const proxy = await startEgressProxy(policy, { contextId: 'ctx-test', lookup, limits });
  cleanup.push(() => proxy.close());
  return proxy;
}

describe('U12 resolve-then-pin', () => {
  test('the first answer is dialled and the second never used, once per connection (absolute form and CONNECT)', async () => {
    const honest = await origin('127.0.0.1', 'honest');
    const decoy = await origin('127.0.0.2', 'decoy');
    if (!honest) throw new Error('cannot bind 127.0.0.1');
    cleanup.push(() => honest.close());
    if (decoy) cleanup.push(() => decoy.close());
    // a rebinding answer: the honest address first, then one that must never be dialled
    const answers: ResolvedAddress[] = [
      { address: '127.0.0.1', family: 4 },
      { address: '127.0.0.2', family: 4 },
    ];
    const calls: string[] = [];
    const lookup: HostResolver = async (hostname) => {
      calls.push(hostname);
      return answers;
    };
    const proxy = await proxyWith(policyFor(honest.port, true), lookup);

    const plain = await viaProxy(proxy.url, `http://${HOST}:${honest.port}/plain`);
    expect(plain).toEqual({ status: 200, body: 'honest' });
    expect(calls, 'resolved exactly once for the request').toEqual([HOST]);

    const { status, socket } = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect(status).toBe(200);
    const inside = await insideTunnel(socket, HOST, '/tunnel');
    expect(inside).toContain('honest');
    expect(calls, 'resolved once more for the tunnel, never again inside it').toEqual([HOST, HOST]);
    socket.destroy();

    expect(honest.hits).toEqual([`honest GET /plain host=${HOST}:${honest.port}`, `honest GET /tunnel host=${HOST}`]);
    if (decoy) expect(decoy.hits, 'the second answer was never dialled').toEqual([]);
    expect(proxy.refused).toEqual([]);
  });

  test('an IP literal is never resolved: the resolver cannot redirect it', async () => {
    const honest = await origin('127.0.0.1', 'honest');
    if (!honest) throw new Error('cannot bind 127.0.0.1');
    cleanup.push(() => honest.close());
    const calls: string[] = [];
    const lookup: HostResolver = async (hostname) => {
      calls.push(hostname);
      return [{ address: '127.0.0.2', family: 4 }];
    };
    const policy: EgressPolicy = {
      ...policyFor(honest.port, true),
      own: [`127.0.0.1:${honest.port}`],
      targetHosts: ['127.0.0.1'],
    };
    const proxy = await proxyWith(policy, lookup);
    expect(await viaProxy(proxy.url, `http://127.0.0.1:${honest.port}/literal`)).toEqual({
      status: 200,
      body: 'honest',
    });
    expect(calls).toEqual([]);
  });

  test('a private-only answer is refused on a remote target, with the verdict private, before any connection', async () => {
    const honest = await origin('127.0.0.1', 'honest');
    if (!honest) throw new Error('cannot bind 127.0.0.1');
    cleanup.push(() => honest.close());
    const lookup: HostResolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const proxy = await proxyWith(policyFor(honest.port, false), lookup);
    const refusals: string[] = [];
    proxy.onRefused((r) => refusals.push(`${r.verdict} ${r.line} ${r.contextId}`));

    expect((await viaProxy(proxy.url, `http://${HOST}:${honest.port}/x`)).status).toBe(403);
    const { status, socket } = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect(status).toBe(403);
    socket.destroy();

    expect(honest.hits, 'nothing reached the loopback origin').toEqual([]);
    expect(refusals).toEqual([
      `private GET http://${HOST}:${honest.port}/x ctx-test`,
      `private CONNECT ${HOST}:${honest.port} ctx-test`,
    ]);
    expect(proxy.refused.map((r) => r.verdict)).toEqual(['private', 'private']);
  });

  test('resolveAndPin picks the first address: a public first answer stands, a private first answer is refused', async () => {
    const rebinding: HostResolver = async () => [
      { address: '192.0.2.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    expect(await resolveAndPin(HOST, rebinding, false)).toEqual({
      ok: true,
      address: { address: '192.0.2.1', family: 4 },
    });
    const reversed: HostResolver = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '192.0.2.1', family: 4 },
    ];
    expect(await resolveAndPin(HOST, reversed, false)).toEqual({ ok: false, reason: 'private' });
    expect(await resolveAndPin(HOST, reversed, true)).toEqual({
      ok: true,
      address: { address: '127.0.0.1', family: 4 },
    });
    const mapped: HostResolver = async () => [{ address: '::ffff:169.254.169.254', family: 6 }];
    expect(await resolveAndPin(HOST, mapped, false)).toEqual({ ok: false, reason: 'private' });
    const empty: HostResolver = async () => [];
    expect(await resolveAndPin(HOST, empty, false)).toEqual({ ok: false, reason: 'unresolved' });
    const failing: HostResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await resolveAndPin(HOST, failing, true)).toEqual({ ok: false, reason: 'unresolved' });
    expect(await resolveAndPin('10.1.1.1', failing, false), 'a literal needs no resolver').toEqual({
      ok: false,
      reason: 'private',
    });
  });

  test('production and outside are refused before the resolver is ever asked', async () => {
    const calls: string[] = [];
    const lookup: HostResolver = async (hostname) => {
      calls.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const proxy = await proxyWith(policyFor(443, true), lookup);
    expect((await viaProxy(proxy.url, 'http://www.example.com/config')).status).toBe(403);
    expect((await tunnel(proxy.url, 'app.prod.example:443')).status).toBe(403);
    expect((await viaProxy(proxy.url, 'http://outside.example/beacon')).status).toBe(403);
    expect(calls).toEqual([]);
    expect(proxy.refused.map((r) => `${r.verdict} ${r.line}`)).toEqual([
      'prod GET http://www.example.com/config',
      'prod CONNECT app.prod.example:443',
      'outside GET http://outside.example/beacon',
    ]);
  });
});

describe('the canary', () => {
  test('is answered 204 by the proxy itself and recorded per context id, never dialled', async () => {
    const calls: string[] = [];
    const lookup: HostResolver = async (hostname) => {
      calls.push(hostname);
      return [];
    };
    const proxy = await proxyWith(policyFor(443, false), lookup);
    expect(proxy.canarySeen).toBe(false);
    expect((await viaProxy(proxy.url, `http://${CANARY_HOST}/?ctx=ctx-other`)).status).toBe(204);
    expect(proxy.canarySeen, 'another context asked, not this one').toBe(false);
    expect((await viaProxy(proxy.url, `http://${CANARY_HOST}/?ctx=ctx-test`)).status).toBe(204);
    expect(proxy.canarySeen).toBe(true);
    expect([...proxy.seen.entries()]).toEqual([
      ['ctx-other', 1],
      ['ctx-test', 1],
    ]);
    expect(calls).toEqual([]);
    expect(proxy.refused).toEqual([]);
  });
});

describe('the limits', () => {
  test('request line and headers over the cap are answered 431 and the socket closed', async () => {
    const proxy: KitEgressProxy = await proxyWith(policyFor(443, false), async () => [], { maxHeaderBytes: 2048 });
    const big = 'x'.repeat(4096);
    const response = await new Promise<string>((resolve, reject) => {
      const url = new URL(proxy.url);
      const socket = net.connect(Number(url.port), url.hostname, () => {
        socket.write(`GET http://${HOST}/ HTTP/1.1\r\nHost: ${HOST}\r\nX-Big: ${big}\r\n\r\n`);
      });
      let out = '';
      socket.on('data', (chunk) => {
        out += chunk;
      });
      socket.once('close', () => resolve(out));
      socket.once('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 (431|400) /);
    expect(proxy.limits.maxHeaderBytes).toBe(2048);
  });

  test('tunnels over the cap are answered 503; closing one frees a slot', async () => {
    const honest = await origin('127.0.0.1', 'honest');
    if (!honest) throw new Error('cannot bind 127.0.0.1');
    cleanup.push(() => honest.close());
    const proxy = await proxyWith(policyFor(honest.port, true), async () => [{ address: '127.0.0.1', family: 4 }], {
      maxTunnels: 2,
    });
    const first = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    const second = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(proxy.tunnels).toBe(2);
    const third = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect(third.status).toBe(503);
    third.socket.destroy();
    first.socket.destroy();
    await expect.poll(() => proxy.tunnels).toBe(1);
    const fourth = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect(fourth.status).toBe(200);
    fourth.socket.destroy();
    second.socket.destroy();
  });

  test('an idle tunnel is closed after idleMs', async () => {
    const honest = await origin('127.0.0.1', 'honest');
    if (!honest) throw new Error('cannot bind 127.0.0.1');
    cleanup.push(() => honest.close());
    const proxy = await proxyWith(policyFor(honest.port, true), async () => [{ address: '127.0.0.1', family: 4 }], {
      idleMs: 200,
    });
    const { status, socket } = await tunnel(proxy.url, `${HOST}:${honest.port}`);
    expect(status).toBe(200);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await expect(
      Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('still open')), 3000))]),
    ).resolves.toBeUndefined();
    await expect.poll(() => proxy.tunnels).toBe(0);
  });
});
