// Stand-in for src/core/broker.ts (Task 1): a loopback server with a per-run token that forwards contract routes
// only. The stand-in checks the token and answers 501 for everything else, so global setup can start and workers
// can see a URL and a token; the real broker forwards to the test API.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Broker, type BrokerOptions, DEFAULTS } from '../../types.ts';
import { Secret } from './secret.ts';

export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const token = new Secret(crypto.randomBytes(32).toString('base64url'), 'broker token');
  const expected = Buffer.from(token.reveal());
  const header = DEFAULTS.brokerTokenHeader.toLowerCase();
  const server = http.createServer((req, res) => {
    const given = Buffer.from(String(req.headers[header] ?? ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'bad-token', message: 'broker: missing or wrong token' } }));
      return;
    }
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'stand-in', message: `broker stand-in: ${options.apiOrigin}${options.basePath}` },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
