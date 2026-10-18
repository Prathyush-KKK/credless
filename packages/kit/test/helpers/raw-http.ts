// Raw HTTP for the broker self-tests (B02, B03): the exact bytes a hostile test could send to the loopback broker,
// and a worker's own environment. Lives outside test/selftest because the spec files there may not import node:http
// or node:net, or read `process` (biome's override, plan §6 F3); this helper is the one place they do, against
// loopback only.
import http from 'node:http';
import net from 'node:net';

export interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One GET through Node's http client: no redirect is followed, nothing is retried. */
export function httpGet(url: string, headers: Record<string, string> = {}): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A request line of the caller's choosing over a raw socket (an http client would normalise it before it left). */
export function rawRequest(url: string, requestLine: string, headers: Record<string, string> = {}): Promise<string> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      const lines = [
        requestLine,
        'Host: 127.0.0.1',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        'Connection: close',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

/** A worker's own environment variable, by name. */
export function workerEnv(name: string): string | undefined {
  return process.env[name];
}
