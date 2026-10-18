// The broker through a real run (B01–B03): what a worker holds, and what the broker it talks to forwards and
// refuses. The runner key never reaches these tests, so the assertions are about shapes and codes; the broker's unit
// test proves the forwarding against a scripted upstream, this one proves the run wires it the same way.
import { DEFAULTS, ENV, expect, type Health, test } from '../../src/index.ts';
import { httpGet, rawRequest, workerEnv } from '../helpers/raw-http.ts';

const brokerUrl = () => workerEnv(ENV.BROKER_URL) ?? '';
const token = () => workerEnv(ENV.BROKER_TOKEN) ?? '';
const withToken = () => ({ [DEFAULTS.brokerTokenHeader]: token() });

test.describe('broker', () => {
  test('B01 a worker holds the broker URL and a per-run token, never the runner key or its handover file', async ({
    kit,
  }) => {
    expect(workerEnv(ENV.RUNNER_KEY)).toBeUndefined();
    expect(workerEnv(ENV.RUNNER_KEY_FILE)).toBeUndefined();
    expect(brokerUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the worker's client is a broker client: its calls reach the test API, the key is added on the far side
    const health = await kit.api.call<Health>('health');
    expect(health.http).toBe(200);
    expect(health.data.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(kit.api.log.at(-1)).toMatchObject({ method: 'GET', path: '/_test/health', status: 200 });
  });

  test('B02 the broker takes the per-run token only: none, a wrong one or a key header instead is 401', async () => {
    const ok = await httpGet(`${brokerUrl()}/_test/health`, withToken());
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.body) as Health).enabled).toBe(true);
    const none = await httpGet(`${brokerUrl()}/_test/health`);
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body)).toEqual({
      error: { code: 'broker-unauthorized', message: 'broker: missing or wrong token' },
    });
    const wrong = await httpGet(`${brokerUrl()}/_test/health`, { [DEFAULTS.brokerTokenHeader]: 'x'.repeat(43) });
    expect(wrong.status).toBe(401);
    const asKey = await httpGet(`${brokerUrl()}/_test/health`, { [DEFAULTS.keyHeader]: token() });
    expect(asKey.status).toBe(401);
    // no answer carries a credential header back, and none quotes the key header by name
    for (const answer of [ok, none, wrong, asKey]) {
      expect(Object.keys(answer.headers).map((h) => h.toLowerCase())).not.toContain(DEFAULTS.keyHeader.toLowerCase());
      expect(answer.body).not.toMatch(new RegExp(DEFAULTS.keyHeader, 'i'));
    }
  });

  test('B03 contract routes only: other paths are 404, absolute-form targets and traversal 400, the sentinel sees nothing', async ({
    personas,
  }) => {
    const [p] = await personas.open('guest');
    const hits = async (): Promise<number> =>
      ((await (await p.context.request.get('/__demo/sentinel')).json()) as { hits: number }).hits;
    const before = await hits();
    for (const notContract of ['/api/me', '/__demo/state', '/_test/health/extra', '/health', '/_test/personas/']) {
      const answer = await httpGet(`${brokerUrl()}${notContract}`, withToken());
      expect(answer.status, notContract).toBe(404);
      expect(JSON.parse(answer.body), notContract).toEqual({
        error: { code: 'broker-not-a-contract-route', message: 'broker: not a contract route' },
      });
    }
    // the demo's extension routes are in the contract: forwarded, and answered by the demo, not by the broker
    const extension = await httpGet(`${brokerUrl()}/_test/workspaces/999999`, withToken());
    expect(extension.status).toBe(404);
    expect((JSON.parse(extension.body) as { error: { code: string } }).error.code).not.toMatch(/^broker-/);
    // an http client would normalise these before they left; a hostile worker would not
    for (const bad of [
      'GET http://127.0.0.1:4319/_test/health HTTP/1.1',
      'GET //127.0.0.1:4319/_test/health HTTP/1.1',
      'GET /_test/../_test/health HTTP/1.1',
      'GET /_test/%2e%2e/health HTTP/1.1',
    ]) {
      expect(await rawRequest(brokerUrl(), bad, withToken()), bad).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(await hits(), 'nothing reached the unlisted host').toBe(before);
    expect(p.guard.violations).toEqual([]);
  });
});
