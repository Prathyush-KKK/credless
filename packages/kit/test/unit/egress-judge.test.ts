// U11: the egress verdict, judged on host and port before any DNS lookup, in the frozen order.
import { describe, expect, test } from 'vitest';
import { CANARY_HOST } from '../../src/brand.ts';
import {
  DEFAULT_ANALYTICS_HOSTS,
  egressPolicyFor,
  hostPort,
  isPrivateAddress,
  judgeEgress,
  normalizeHost,
} from '../../src/fixtures/egress.ts';
import type { EgressPolicy, RunConfig } from '../../src/types.ts';

const remote: EgressPolicy = {
  own: [hostPort('https://dev.app.example'), hostPort('https://dev.api.example')],
  thirdParty: ['fonts.gstatic.com', '*.googleapis.com'],
  analytics: [...DEFAULT_ANALYTICS_HOSTS],
  production: {
    domains: ['example.com', 'app.example'],
    words: ['prod', 'production'],
    nonProductionPattern: '^dev\\.',
  },
  targetHosts: ['dev.app.example', 'dev.api.example'],
  allowPrivate: false,
};

const judge = (host: string, port = 443, policy = remote) => judgeEgress(host, port, policy);

describe('U11 the egress verdict', () => {
  test('host:port of an origin fills in the default port and normalises the host', () => {
    expect(hostPort('https://Dev.App.Example')).toBe('dev.app.example:443');
    expect(hostPort('http://127.0.0.1:4310')).toBe('127.0.0.1:4310');
    expect(hostPort('ws://127.0.0.1:4311/socket')).toBe('127.0.0.1:4311');
    expect(hostPort('wss://dev.api.example/live')).toBe('dev.api.example:443');
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('Dev.App.Example.')).toBe('dev.app.example');
  });

  test('production is refused first: by word anywhere, by domain unless own or non-production', () => {
    for (const host of [
      'app.prod.example',
      'prod-api.example.com',
      'www.production.example',
      'www.example.com',
      'example.com',
      'app.example',
    ]) {
      expect(judge(host), host).toBe('prod');
    }
    // a production word wins over every other list, even on the run's own port or an analytics rule
    expect(judge('prod.googletagmanager.com')).toBe('prod');
    expect(judge('prod.app.example', 443)).toBe('prod');
    // the run's own hosts and the non-production pattern are not production
    expect(judge('dev.app.example')).toBe('own');
    expect(judge('dev.other.example.com')).toBe('dev');
  });

  test('the canary host is answered, never dialled, whatever the port', () => {
    expect(judge(CANARY_HOST, 80)).toBe('canary');
    expect(judge(CANARY_HOST, 443)).toBe('canary');
    expect(judge('canary.other.invalid', 80)).toBe('outside');
    expect(judge('my-canary.invalid', 80, { ...remote, canaryHost: 'my-canary.invalid' })).toBe('canary');
  });

  test('own origins match by exact host and port; case and a trailing dot do not matter', () => {
    expect(judge('dev.app.example')).toBe('own');
    expect(judge('DEV.APP.EXAMPLE.')).toBe('own');
    expect(judge('dev.api.example')).toBe('own');
    expect(judge('dev.app.example', 80), 'another web port: a non-production host of the organisation').toBe('dev');
    expect(judge('dev.app.example', 8443), 'not a web port: outside').toBe('outside');
  });

  test('analytics is refused on any port; third-party and dev pass on web ports only', () => {
    expect(judge('www.googletagmanager.com')).toBe('analytics');
    expect(judge('googletagmanager.com')).toBe('analytics');
    expect(judge('www.google-analytics.com', 8080)).toBe('analytics');
    expect(judge('fonts.gstatic.com')).toBe('third-party');
    expect(judge('fonts.gstatic.com', 80)).toBe('third-party');
    expect(judge('fonts.gstatic.com', 8080)).toBe('outside');
    expect(judge('fonts.googleapis.com')).toBe('third-party');
    expect(judge('googleapis.com'), 'a *. rule covers the hosts under the domain, not the apex').toBe('outside');
    expect(judge('dev.storage.example')).toBe('dev');
    expect(judge('dev.storage.example', 22)).toBe('outside');
  });

  test('everything else is outside, including loopback and private literals on a remote target', () => {
    expect(judge('outside.example')).toBe('outside');
    expect(judge('127.0.0.1', 4319)).toBe('outside');
    expect(judge('10.0.0.5', 443)).toBe('outside');
    expect(judge('[::1]', 443)).toBe('outside');
  });

  test('a local target lists its loopback origins as own; a private answer is allowed there only', () => {
    const config = {
      endpoints: {
        web: 'http://127.0.0.1:4310',
        api: 'http://127.0.0.1:4311',
        testApi: 'http://127.0.0.1:4311',
        kind: 'local',
      },
      targetHosts: ['127.0.0.1'],
      kit: {
        production: {
          domains: ['example.com'],
          words: ['prod', 'production'],
          nonProductionPattern: '^dev\\.example\\.com$',
        },
        hosts: { thirdParty: [], analytics: [] },
      },
    } as unknown as RunConfig;
    const policy = egressPolicyFor(config);
    expect(policy.own).toEqual(['127.0.0.1:4310', '127.0.0.1:4311']);
    expect(policy.allowPrivate).toBe(true);
    expect(policy.analytics, 'an empty analytics list falls back to the kit defaults').toEqual(DEFAULT_ANALYTICS_HOSTS);
    expect(judge('127.0.0.1', 4310, policy)).toBe('own');
    expect(judge('127.0.0.1', 4319, policy)).toBe('outside');
    expect(judge('www.example.com', 443, policy)).toBe('prod');
    expect(judge('app.prod.example', 443, policy)).toBe('prod');
    expect(judge('dev.example.com', 443, policy)).toBe('dev');
    expect(judge('outside.example', 443, policy)).toBe('outside');
    expect(judge('www.googletagmanager.com', 443, policy)).toBe('analytics');
  });

  test('private ranges: every row of PRIVATE_RANGES, the IPv4-mapped forms, and nothing else', () => {
    for (const address of [
      '0.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fe80::1%eth0',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '100.128.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '2001:db8::1',
      '::ffff:8.8.8.8',
      '2606:4700::1111',
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    expect(isPrivateAddress('not-an-address'), 'unparseable is refused').toBe(true);
  });
});
