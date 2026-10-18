// Docker mode's pieces and the environment allowlist: the image follows the installed Playwright and is pinned only
// when a digest is known; `docker run` gets the three mounts and the allowlisted environment, secrets by name only;
// a child's environment is an allowlist, never the parent's.
import { describe, expect, it } from 'vitest';
import { dockerRunArgs, IMAGE_DIGESTS, imageFor, inRun, inWork } from '../../src/runner/docker.ts';
import { childEnvironment, dockerCliEnvironment } from '../../src/runner/spawn.ts';

describe('image', () => {
  it('follows the Playwright version and says whether it is pinned', () => {
    const unpinned = imageFor('1.64.1');
    expect(unpinned.tag).toBe('mcr.microsoft.com/playwright:v1.64.1-noble');
    expect(unpinned.pinned).toBe(IMAGE_DIGESTS['1.64.1'] !== null);
    expect(imageFor('9.9.9').pinned).toBe(false);
    expect(imageFor('1.64.1', 'ghcr.io/example/pw:custom')).toEqual({
      ref: 'ghcr.io/example/pw:custom',
      tag: 'ghcr.io/example/pw:custom',
      pinned: false,
    });
  });
  it('never invents a digest', () => {
    for (const digest of Object.values(IMAGE_DIGESTS))
      if (digest !== null) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('paths and args', () => {
  it('maps staging and project paths into the container', () => {
    const staging = process.platform === 'win32' ? 'C:\\s' : '/s';
    const file = `${staging}${process.platform === 'win32' ? '\\' : '/'}.secret-1-key`;
    expect(inRun('docker', staging, file)).toBe('/staging/.secret-1-key');
    expect(inRun('native', staging, file)).toBe(file);
    expect(() => inRun('docker', staging, '/elsewhere/x')).toThrow(/not inside staging/);
    const root = process.platform === 'win32' ? 'C:\\p' : '/p';
    expect(inWork(root, `${root}${process.platform === 'win32' ? '\\' : '/'}node_modules/x/cli.js`)).toBe(
      '/work/node_modules/x/cli.js',
    );
    expect(inWork(root, root)).toBe('/work');
    expect(inWork(root, '/usr/lib/node_modules/x/cli.js')).toBeNull();
  });

  it('builds docker run with the mounts, the env, names only for secrets, and the command last', () => {
    const args = dockerRunArgs({
      image: 'img:tag',
      projectRoot: '/p',
      stagingDir: '/s',
      env: { CREDLESS_TARGET: 'dev', CREDLESS_RUNNER_KEY_FILE: '/staging/.secret-1-key' },
      passNames: ['CREDLESS_EVIDENCE_KEY'],
      ipcHost: true,
      command: ['node', '/work/node_modules/credless/dist/cli.js', '__suite', '-g', 'x'],
    });
    expect(args).toEqual([
      'run',
      '--rm',
      '--init',
      '--ipc=host',
      '-e',
      'CREDLESS_EVIDENCE_KEY',
      '-e',
      'CREDLESS_TARGET=dev',
      '-e',
      'CREDLESS_RUNNER_KEY_FILE=/staging/.secret-1-key',
      '-v',
      '/p:/work',
      '-v',
      '/s:/staging',
      '-w',
      '/work',
      'img:tag',
      'node',
      '/work/node_modules/credless/dist/cli.js',
      '__suite',
      '-g',
      'x',
    ]);
    expect(args.join(' ')).not.toMatch(/CREDLESS_EVIDENCE_KEY=/);
  });
});

describe('environment allowlist', () => {
  const parent = {
    PATH: '/bin',
    HOME: '/home/x',
    CREDLESS_RUNNER_KEY: 'secret-value-1',
    CREDLESS_SIGNIN_PASSWORD: 'secret-value-2',
    CREDLESS_BROKER_TOKEN: 'secret-value-3',
    CREDLESS_TRACE: 'on',
    CREDLESS_WEB_URL: 'https://dev.app.example',
    PLAYWRIGHT_BROWSERS_PATH: '/pw',
    AWS_SECRET_ACCESS_KEY: 'nope',
    NODE_OPTIONS: '--max-old-space-size=4096',
    DEMO_WEB: 'http://127.0.0.1:1',
  };
  it('passes the shell basics, the kit knobs and PLAYWRIGHT_*, never a secret or an unrelated variable', () => {
    const env = childEnvironment(parent, { CREDLESS_RUN_ID: '20261008T101500Z-ab12' }, { platform: 'linux' });
    expect(Object.keys(env).sort()).toEqual([
      'CREDLESS_RUN_ID',
      'CREDLESS_TRACE',
      'CREDLESS_WEB_URL',
      'DEMO_WEB',
      'HOME',
      'NODE_OPTIONS',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
    ]);
    expect(JSON.stringify(env)).not.toContain('secret-value');
  });
  it('drops host-only names for a container and keeps the kit knobs', () => {
    const env = childEnvironment(parent, {}, { forContainer: true, platform: 'linux' });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.CREDLESS_TRACE).toBe('on');
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/pw');
  });
  it('matches names case-insensitively on Windows', () => {
    const env = childEnvironment(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Secret: 'x' },
      {},
      { platform: 'win32' },
    );
    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
  });
  it('gives the docker CLI only what it needs', () => {
    expect(dockerCliEnvironment({ ...parent, DOCKER_HOST: 'unix:///x' })).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      DOCKER_HOST: 'unix:///x',
    });
  });
});
