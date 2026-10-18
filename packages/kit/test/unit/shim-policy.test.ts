// The worker shim's policy: loopback is always allowed, the proxy when there is one, nothing else; `off` and unset
// leave the shim inert.
import { describe, expect, it } from 'vitest';
import { allowed, isLoopback, policyFrom, WORKER_PROXY_ENV } from '../../src/runner/shim-policy.ts';
import { connectTarget } from '../../src/runner/worker-shim.ts';

describe('policy', () => {
  it('names the variable from the prefix', () => {
    expect(WORKER_PROXY_ENV).toBe('CREDLESS_WORKER_PROXY_URL');
  });
  it('is inert unless asked', () => {
    expect(policyFrom(undefined)).toBeNull();
    expect(policyFrom('off')).toBeNull();
    expect(policyFrom('not a url')).toBeNull();
    expect(policyFrom('loopback')).toEqual({ proxy: null });
    expect(policyFrom('http://127.0.0.1:4555')).toEqual({ proxy: { host: '127.0.0.1', port: 4555 } });
  });
  it('knows loopback in every spelling', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0'])
      expect(isLoopback(h), h).toBe(true);
    for (const h of ['192.0.2.1', '10.0.0.1', 'dev.app.example', '::ffff:10.0.0.1', '128.0.0.1'])
      expect(isLoopback(h), h).toBe(false);
  });
  it('allows the proxy and loopback only', () => {
    const policy = policyFrom('http://192.0.2.9:3128') as NonNullable<ReturnType<typeof policyFrom>>;
    expect(allowed(policy, '192.0.2.9', 3128)).toBe(true);
    expect(allowed(policy, '192.0.2.9', 80)).toBe(false);
    expect(allowed(policy, '127.0.0.1', 80)).toBe(true);
    expect(allowed(policy, 'dev.app.example', 443)).toBe(false);
    expect(allowed({ proxy: null }, 'dev.app.example', 443)).toBe(false);
  });
  it('reads the three spellings of connect()', () => {
    expect(connectTarget([{ host: 'a', port: 1 }])).toEqual({ host: 'a', port: 1, path: null });
    expect(connectTarget([{ port: 1 }])).toEqual({ host: 'localhost', port: 1, path: null });
    expect(connectTarget([{ path: '/tmp/sock' }])).toEqual({ host: null, port: null, path: '/tmp/sock' });
    expect(connectTarget([80, 'b', () => {}])).toEqual({ host: 'b', port: 80, path: null });
    expect(connectTarget(['80'])).toEqual({ host: 'localhost', port: 80, path: null });
    expect(connectTarget(['/tmp/sock'])).toEqual({ host: null, port: null, path: '/tmp/sock' });
    expect(connectTarget([[{ host: 'c', port: 443 }, () => {}]])).toEqual({ host: 'c', port: 443, path: null });
  });
});
