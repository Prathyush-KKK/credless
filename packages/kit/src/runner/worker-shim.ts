// The advisory worker shim (plan §6 T1 b), loaded into every process of a run through `NODE_OPTIONS=--import`.
//
// A test worker has no business dialling anything but loopback: the broker, the per-context egress proxies and the
// browsers are all local, and the app is reached through the browser or through the context's proxy. So when the
// run asks for it, this file wraps `net.Socket.prototype.connect` (which `net`, `tls`, `http`, `https` and `fetch`
// all end up in) and `dgram` sockets to refuse any other destination before a connection is attempted, logging one
// line per destination. With a proxy URL it also publishes `HTTP_PROXY`/`HTTPS_PROXY` for Node's `NODE_USE_ENV_PROXY`
// (Node 24+; the parent must set that variable, because Node reads it before any `--import` runs).
//
// It is advisory: code that reaches `process.binding`, a native addon or a child process is not stopped. The lint
// gate (`check-tests`) and the canary are the layers that make such code visible; `run --isolate` (v0.2) is the one
// that makes it impossible. The file imports nothing but Node built-ins and the brand, so it loads before anything.
import dgram from 'node:dgram';
import net from 'node:net';
import { CLI_NAME } from '../brand.ts';
import { allowed, policyFrom, type ShimPolicy, WORKER_PROXY_ENV } from './shim-policy.ts';

const seen = new Set<string>();

function refusal(host: string, port: number): NodeJS.ErrnoException {
  const where = `${host}:${port}`;
  if (!seen.has(where)) {
    seen.add(where);
    process.stderr.write(
      `${CLI_NAME} worker shim: refused ${where} (a worker reaches the network only through the egress proxy)\n`,
    );
  }
  const error: NodeJS.ErrnoException = new Error(`${CLI_NAME} worker shim: refused ${where}`);
  error.code = 'ECONNREFUSED';
  error.syscall = 'connect';
  return error;
}

interface ConnectTarget {
  host: string | null;
  port: number | null;
  path: string | null;
}

/** The destination of a `socket.connect(...)` call in its three spellings. */
export function connectTarget(args: unknown[]): ConnectTarget {
  const first = args[0];
  // `net.connect()` and the http agents call `socket.connect([options, callback])` with the already normalised array.
  if (Array.isArray(first)) return connectTarget(first as unknown[]);
  if (first && typeof first === 'object') {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return { host: null, port: null, path: o.path };
    return { host: o.host ?? 'localhost', port: o.port === undefined ? null : Number(o.port), path: null };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port: Number(first), path: null };
  }
  if (typeof first === 'string') return { host: null, port: null, path: first };
  return { host: null, port: null, path: null };
}

/** Install the guard for a policy. Returns a function that removes it (for tests). */
export function installShim(policy: ShimPolicy): () => void {
  const originalConnect = net.Socket.prototype.connect;
  const originalCreateSocket = dgram.createSocket;

  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    // Pipes and sockets with no destination (an fd handed in) are local by construction.
    if (target.host !== null && target.port !== null && !allowed(policy, target.host, target.port)) {
      const error = refusal(target.host, target.port);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const guardDgram = (socket: dgram.Socket): dgram.Socket => {
    const send = socket.send.bind(socket);
    const connect = socket.connect.bind(socket);
    socket.send = ((...args: unknown[]) => {
      // send(msg, [offset, length,] port, address, [callback]): the address is the first string after the message
      // and the port the number right before it; a connected socket sends with neither.
      const at = args.findIndex((a, i) => i >= 1 && typeof a === 'string');
      const address = at > 0 ? (args[at] as string) : undefined;
      const port = at > 1 && typeof args[at - 1] === 'number' ? (args[at - 1] as number) : 0;
      if (address && !allowed(policy, address, port)) {
        const error = refusal(address, port);
        const callback = args[args.length - 1];
        if (typeof callback === 'function') process.nextTick(() => (callback as (e: Error) => void)(error));
        else process.nextTick(() => socket.emit('error', error));
        return;
      }
      return (send as (...a: unknown[]) => void)(...args);
    }) as typeof socket.send;
    socket.connect = ((port: number, address?: string | (() => void), callback?: () => void) => {
      const host = typeof address === 'string' ? address : 'localhost';
      if (!allowed(policy, host, port)) throw refusal(host, port);
      return typeof address === 'function' ? connect(port, address) : connect(port, address, callback);
    }) as typeof socket.connect;
    return socket;
  };
  dgram.createSocket = ((...args: unknown[]) =>
    guardDgram((originalCreateSocket as (...a: unknown[]) => dgram.Socket)(...args))) as typeof dgram.createSocket;

  if (policy.proxy) {
    const url = `http://${policy.proxy.host}:${policy.proxy.port}`;
    process.env.HTTP_PROXY ??= url;
    process.env.HTTPS_PROXY ??= url;
    process.env.NO_PROXY ??= 'localhost,127.0.0.1,::1';
  }

  return () => {
    net.Socket.prototype.connect = originalConnect;
    dgram.createSocket = originalCreateSocket;
  };
}

const active = policyFrom(process.env[WORKER_PROXY_ENV]);
if (active) installShim(active);
