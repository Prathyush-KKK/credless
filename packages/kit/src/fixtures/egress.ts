// The egress proxy: the network-level half of the guard (plan §6 T1, T4, T5).
//
// Playwright's route handler never sees a redirect hop (Chromium) or a WebSocket handshake, and context.request is
// not routed at all, so a page that redirects to production would load it. Every persona browser context gets its
// own loopback HTTP proxy that decides on the host and port BEFORE any connection or DNS lookup: the run's own
// origins, the listed third-party hosts and the organisation's non-production hosts pass; production, analytics
// and everything else are refused (403). Each refusal is reported to the guard, which fails the test or lists it.
//
// After the verdict the host is resolved once, through an injectable resolver. On a remote target an answer in a
// private or loopback range is refused; the first address is dialled and kept for the connection, so a second
// answer (DNS rebinding) is never used. Host and SNI stay the browser's: CONNECT is an opaque tunnel and TLS is end
// to end. The proxy answers the canary host itself with 204 and records which context asked, which is how the
// fixture proves a context's traffic really goes through its own proxy.
//
// It handles the three ways a browser talks to an HTTP proxy: CONNECT tunnels (https, wss and context.request to
// https), absolute-URI requests (plain http, the canary) and absolute-URI upgrades (plain ws).
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { KIT_NAME } from '../brand.ts';
import { hostMatchesRule, isNonProdHost, isProdHost } from '../config/load.ts';
import {
  DEFAULTS,
  EGRESS_LIMITS,
  EGRESS_PASSES,
  type EgressLimits,
  type EgressPolicy,
  type EgressProxy,
  type EgressRefusal,
  type EgressVerdict,
  type HostGlob,
  type HostResolver,
  PRIVATE_RANGES,
  type ResolvedAddress,
  type RunConfig,
} from '../types.ts';

/**
 * Analytics hosts the kit aborts by default, so test browsers never count as users. A config's `hosts.analytics`
 * replaces the list; the demo config spells it out. Both the apex and the hosts under it are listed, because a
 * `*.` rule covers the hosts under a domain only (config/load.ts, `hostMatchesRule`).
 */
export const DEFAULT_ANALYTICS_HOSTS: readonly HostGlob[] = [
  'google-analytics.com',
  '*.google-analytics.com',
  'analytics.google.com',
  '*.analytics.google.com',
  'googletagmanager.com',
  '*.googletagmanager.com',
  'doubleclick.net',
  '*.doubleclick.net',
  '*.facebook.net',
  'clarity.ms',
  '*.clarity.ms',
  'hotjar.com',
  '*.hotjar.com',
  'mixpanel.com',
  '*.mixpanel.com',
  'segment.io',
  '*.segment.io',
  'segment.com',
  '*.segment.com',
];

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Lowercase, no IPv6 brackets, no trailing dot: the form every host comparison uses. */
export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

/** `host:port` of an origin with the scheme's default port filled in, the form of `EgressPolicy.own`. */
export function hostPort(origin: string): string {
  const url = new URL(origin);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return `${normalizeHost(url.hostname)}:${url.port || (secure ? 443 : 80)}`;
}

function normalizeHostPort(entry: string): string {
  const at = entry.lastIndexOf(':');
  return at < 0 ? normalizeHost(entry) : `${normalizeHost(entry.slice(0, at))}:${entry.slice(at + 1)}`;
}

/** Does any host rule (exact host or `*.label.tld`) match the hostname? */
export function matchesAnyRule(hostname: string, rules: readonly HostGlob[]): boolean {
  return rules.some((rule) => hostMatchesRule(hostname, rule));
}

/**
 * The decision for one host and port, before any DNS lookup, in the frozen order: production first and never let
 * through, then the canary, the run's own origins (exact port), analytics (any port), third-party and the
 * organisation's non-production hosts (web ports only), and `outside` for everything else.
 */
export function judgeEgress(hostname: string, port: number, policy: EgressPolicy): EgressVerdict {
  const host = normalizeHost(hostname);
  if (isProdHost(host, policy.production, policy.targetHosts)) return 'prod';
  if (host === normalizeHost(policy.canaryHost ?? DEFAULTS.canaryHost)) return 'canary';
  const target = `${host}:${port}`;
  if (policy.own.some((own) => normalizeHostPort(own) === target)) return 'own';
  if (matchesAnyRule(host, policy.analytics)) return 'analytics';
  const webPort = port === 80 || port === 443;
  if (webPort && matchesAnyRule(host, policy.thirdParty)) return 'third-party';
  if (webPort && isNonProdHost(host, policy.production)) return 'dev';
  return 'outside';
}

/** The policy of a run: its origins, its host lists and its production rules, as strings a worker can be handed. */
export function egressPolicyFor(config: RunConfig): EgressPolicy {
  const { web, api, testApi, kind } = config.endpoints;
  const analytics = config.kit.hosts?.analytics;
  return {
    own: [...new Set([web, api, testApi].map(hostPort))],
    thirdParty: config.kit.hosts?.thirdParty ?? [],
    analytics: analytics && analytics.length > 0 ? analytics : [...DEFAULT_ANALYTICS_HOSTS],
    production: config.kit.production,
    targetHosts: config.targetHosts,
    allowPrivate: kind === 'local',
    canaryHost: DEFAULTS.canaryHost,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Private ranges and resolve-then-pin (plan §6 T4)
// ---------------------------------------------------------------------------------------------------------------

interface Cidr {
  bits: bigint;
  prefix: number;
  family: 4 | 6;
}

function parseIPv4(address: string): bigint | null {
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function parseIPv6(address: string): bigint | null {
  // a zone id (fe80::1%eth0) is not part of the address
  const text = address.replace(/%.*$/, '').toLowerCase();
  if (!net.isIPv6(text)) return null;
  const expand = (part: string): string[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    const last = groups[groups.length - 1] ?? '';
    if (last.includes('.')) {
      // an embedded dotted quad (::ffff:127.0.0.1) is the last two groups
      const v4 = parseIPv4(last);
      if (v4 === null) return null;
      groups.pop();
      groups.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
    }
    return groups;
  };
  const compressed = text.includes('::');
  const [left = '', right = ''] = text.split('::');
  const head = expand(left);
  const tail = compressed ? expand(right) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (!compressed && missing !== 0)) return null;
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function parseCidr(range: string): Cidr {
  const [address = '', prefixText] = range.split('/');
  const v4 = parseIPv4(address);
  if (v4 !== null) return { bits: v4, prefix: Number(prefixText ?? 32), family: 4 };
  const v6 = parseIPv6(address);
  if (v6 === null) throw new Error(`PRIVATE_RANGES: ${range} is not an address range`);
  return { bits: v6, prefix: Number(prefixText ?? 128), family: 6 };
}

const RANGES: readonly Cidr[] = PRIVATE_RANGES.map(parseCidr);

function inRanges(bits: bigint, family: 4 | 6): boolean {
  const width = family === 4 ? 32 : 128;
  return RANGES.some((range) => {
    if (range.family !== family) return false;
    const shift = BigInt(width - range.prefix);
    return bits >> shift === range.bits >> shift;
  });
}

/**
 * Is an address in {@link PRIVATE_RANGES}? IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) are judged as their
 * IPv4 form too, and anything that does not parse is private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return inRanges(v4, 4);
  const v6 = parseIPv6(address);
  if (v6 === null) return true;
  if (v6 >> 32n === 0xffffn && inRanges(v6 & 0xffffffffn, 4)) return true;
  return inRanges(v6, 6);
}

/** The system resolver, `dns.lookup` with every address, in the order the OS gives them. */
export const systemLookup: HostResolver = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

export type PinResult = { ok: true; address: ResolvedAddress } | { ok: false; reason: 'private' | 'unresolved' };

/**
 * Resolve a host once and choose the address to dial: the first answer, refused when it is private on a remote
 * target. An IP literal resolves to itself, so a resolver can never redirect it. The caller dials this address and
 * nothing else for the life of the connection.
 */
export async function resolveAndPin(host: string, lookup: HostResolver, allowPrivate: boolean): Promise<PinResult> {
  const literal = net.isIP(host);
  let addresses: ResolvedAddress[] = [];
  if (literal) {
    addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      addresses = [];
    }
  }
  const first = addresses[0];
  if (!first) return { ok: false, reason: 'unresolved' };
  if (!allowPrivate && isPrivateAddress(first.address)) return { ok: false, reason: 'private' };
  return { ok: true, address: first };
}

// ---------------------------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------------------------

export interface StartEgressProxyOptions {
  /** which browser context this proxy serves; the canary records it (default: a random id) */
  contextId?: string;
  /** injectable resolver (unit test U12, self-test G13); default: the system's `dns.lookup` */
  lookup?: HostResolver;
  /** overrides of {@link EGRESS_LIMITS} */
  limits?: Partial<EgressLimits>;
}

/** The kit's proxy: the frozen {@link EgressProxy} plus what the fixtures and the self-tests read. */
export interface KitEgressProxy extends EgressProxy {
  /** how often each context id asked the canary (`?ctx=<id>`; `''` for a canary without one) */
  readonly seen: ReadonlyMap<string, number>;
  /** tunnels open right now */
  readonly tunnels: number;
  readonly limits: Readonly<EgressLimits>;
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:\s/@]+):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1] as string, port } : null;
}

function withoutHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

const rawAnswer = (status: number, text: string) =>
  `HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;

/** Start one context's loopback proxy. `close()` destroys every tunnel it still holds. */
export async function startEgressProxy(
  policy: EgressPolicy,
  options: StartEgressProxyOptions = {},
): Promise<KitEgressProxy> {
  const limits: EgressLimits = { ...EGRESS_LIMITS, ...options.limits };
  const contextId = options.contextId ?? `ctx-${randomBytes(6).toString('hex')}`;
  const lookup = options.lookup ?? systemLookup;
  const refused: EgressRefusal[] = [];
  const listeners: Array<(refusal: EgressRefusal) => void> = [];
  const seen = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  let tunnels = 0;

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const refuse = (verdict: EgressVerdict, line: string) => {
    const refusal: EgressRefusal = { verdict, line, contextId };
    refused.push(refusal);
    for (const listener of listeners) listener(refusal);
  };
  const answer = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end(`${KIT_NAME} egress proxy: ${text}`);
  };

  const recordCanary = (ctx: string) => seen.set(ctx, (seen.get(ctx) ?? 0) + 1);
  const answerCanary = (ctx: string, res: http.ServerResponse) => {
    recordCanary(ctx);
    res.writeHead(204, { 'Cache-Control': 'no-store', Connection: 'close' });
    res.end();
  };
  // Answers canary requests that arrive inside a CONNECT tunnel; it never listens, sockets are handed to it.
  const canaryServer = http.createServer({ maxHeaderSize: limits.maxHeaderBytes }, (req, res) => {
    answerCanary(new URL(req.url ?? '/', 'http://canary.invalid').searchParams.get('ctx') ?? '', res);
  });

  // Plain http through a proxy: the request line carries the absolute URL. The canary is answered here.
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      return answer(res, 400, 'absolute URL expected');
    }
    if (target.protocol !== 'http:') return answer(res, 400, 'http only (https goes through CONNECT)');
    const port = Number(target.port || 80);
    const verdict = judgeEgress(target.hostname, port, policy);
    if (verdict === 'canary') return answerCanary(target.searchParams.get('ctx') ?? '', res);
    const line = `${req.method ?? 'GET'} ${target.origin}${target.pathname}`;
    if (!EGRESS_PASSES.has(verdict)) {
      refuse(verdict, line);
      return answer(res, 403, 'refused');
    }
    const pin = await resolveAndPin(normalizeHost(target.hostname), lookup, policy.allowPrivate);
    if (!pin.ok) {
      if (pin.reason === 'private') {
        refuse('private', line);
        return answer(res, 403, 'refused');
      }
      return answer(res, 502, 'could not resolve the host');
    }
    const headers = withoutHopByHop(req.headers);
    headers.host = target.host;
    const upstream = http.request(
      {
        host: pin.address.address,
        family: pin.address.family,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        agent: false,
        timeout: limits.idleMs,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.statusMessage, withoutHopByHop(reply.headers));
        reply.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  };

  // https, wss and context.request: a tunnel to host:port, opened only for a host that passes and an address that
  // is not private on a remote target; the address is dialled directly, so nothing resolves the name again.
  const handleConnect = async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      client.end(rawAnswer(400, 'Bad Request'));
      return;
    }
    const host = normalizeHost(authority.host);
    const verdict = judgeEgress(host, authority.port, policy);
    const line = `CONNECT ${host}:${authority.port}`;
    if (verdict === 'canary') {
      // Playwright's context.request tunnels plain http too: open the "tunnel" and answer the inner request here.
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) client.unshift(head);
      canaryServer.emit('connection', client);
      return;
    }
    if (!EGRESS_PASSES.has(verdict)) {
      refuse(verdict, line);
      client.end(rawAnswer(403, 'Forbidden'));
      return;
    }
    if (tunnels >= limits.maxTunnels) {
      client.end(rawAnswer(503, 'Service Unavailable'));
      return;
    }
    tunnels += 1;
    client.once('close', () => {
      tunnels -= 1;
    });
    const pin = await resolveAndPin(host, lookup, policy.allowPrivate);
    if (client.destroyed) return;
    if (!pin.ok) {
      if (pin.reason === 'private') {
        refuse('private', line);
        client.end(rawAnswer(403, 'Forbidden'));
      } else {
        client.end(rawAnswer(502, 'Bad Gateway'));
      }
      return;
    }
    let open = false;
    const upstream = track(
      net.connect({ host: pin.address.address, family: pin.address.family, port: authority.port }),
    );
    upstream.setTimeout(limits.idleMs, () => upstream.destroy());
    client.setTimeout(limits.idleMs, () => client.destroy());
    upstream.once('connect', () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => {
      if (!open && !client.destroyed) client.end(rawAnswer(502, 'Bad Gateway'));
      else client.destroy();
    });
    upstream.once('close', () => client.destroy());
    client.once('close', () => upstream.destroy());
  };

  // Plain ws through a proxy without CONNECT: the upgrade request carries the absolute URL.
  const handleUpgrade = async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      client.end(rawAnswer(400, 'Bad Request'));
      return;
    }
    const port = Number(target.port || 80);
    const plain = target.protocol === 'http:' || target.protocol === 'ws:';
    const verdict = plain ? judgeEgress(target.hostname, port, policy) : 'outside';
    const line = `UPGRADE ${target.origin}${target.pathname}`;
    if (!EGRESS_PASSES.has(verdict)) {
      refuse(verdict, line);
      client.end(rawAnswer(403, 'Forbidden'));
      return;
    }
    const pin = await resolveAndPin(normalizeHost(target.hostname), lookup, policy.allowPrivate);
    if (client.destroyed) return;
    if (!pin.ok) {
      if (pin.reason === 'private') refuse('private', line);
      client.end(
        rawAnswer(pin.reason === 'private' ? 403 : 502, pin.reason === 'private' ? 'Forbidden' : 'Bad Gateway'),
      );
      return;
    }
    const upstream = track(net.connect({ host: pin.address.address, family: pin.address.family, port }));
    upstream.setTimeout(limits.idleMs, () => upstream.destroy());
    client.setTimeout(limits.idleMs, () => client.destroy());
    upstream.once('connect', () => {
      const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] as string;
        if (/^proxy-/i.test(name)) continue;
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? target.host : (req.rawHeaders[i + 1] as string)}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
  };

  const server = http.createServer(
    { maxHeaderSize: limits.maxHeaderBytes, keepAliveTimeout: limits.idleMs },
    (req, res) => {
      void handleRequest(req, res);
    },
  );
  // Every client socket (keep-alive, tunnels, upgrades) is tracked from the start, with an error handler of its
  // own: after a CONNECT or an upgrade the HTTP server hands the socket over without one.
  server.on('connection', (socket: net.Socket) => void track(socket));
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    void handleConnect(req, client, head);
  });
  server.on('upgrade', (req, client: net.Socket, head: Buffer) => {
    void handleUpgrade(req, client, head);
  });
  // A request line plus headers over the cap (or anything unparseable) is answered and the socket closed.
  server.on('clientError', (error: NodeJS.ErrnoException, socket: net.Socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable || socket.destroyed) {
      socket.destroy();
      return;
    }
    const overflow = error.code === 'HPE_HEADER_OVERFLOW';
    socket.end(rawAnswer(overflow ? 431 : 400, overflow ? 'Request Header Fields Too Large' : 'Bad Request'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    contextId,
    refused,
    seen,
    limits,
    get canarySeen() {
      return seen.has(contextId);
    },
    get tunnels() {
      return tunnels;
    },
    onRefused: (listener) => void listeners.push(listener),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
