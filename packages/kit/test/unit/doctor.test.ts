// Q03: doctor reports key sources by presence only (a stand-in `op`, `infisical` and `kubectl` on PATH are never run),
// never prints a key that is in the environment, changes nothing on disk, and reads the target's health without a key:
// 401 is the lock working, a body with keyId or sinks is the lock broken.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctor } from '../../src/runner/doctor.ts';
import { cli, makeProject, type TempProject } from './helpers/tmp-project.ts';

const made: TempProject[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.cleanup();
});
const project = (options?: Parameters<typeof makeProject>[0]) => {
  const p = makeProject(options);
  made.push(p);
  return p;
};
const posix = process.platform !== 'win32';

describe('Q03 through the CLI', () => {
  it.skipIf(!posix)(
    'names the key source tool by presence, runs nothing, prints no key, writes nothing',
    () => {
      const p = project({ key: `{ source: 'exec', preset: 'op', ref: 'op://vault/item/field' }` });
      const bin = path.join(p.dir, 'bin');
      const ran = path.join(p.dir, 'ran');
      fs.mkdirSync(bin);
      // Stand-ins that record being run. docker answers nothing, so the run mode is native.
      for (const tool of ['op', 'infisical', 'kubectl', 'docker']) {
        fs.writeFileSync(
          path.join(bin, tool),
          `#!/bin/sh\necho "${tool} $*" >> "${ran}"\n[ "${tool}" = docker ] && exit 1\nexit 0\n`,
          { mode: 0o755 },
        );
      }
      const standIn = 'KIT-DOCTOR-KEY-STANDIN-6c1f';
      const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CREDLESS_RUNNER_KEY: standIn };
      const r = cli(p, ['doctor', '--target', 'dev', '--slot', 'e', '--offline', '--security'], env);
      expect(r.all).toContain('(preset op; not run by doctor): op is installed');
      expect(r.all).toContain('slot e (from --slot)');
      expect(r.all).toContain('not probed (--offline)');
      expect(r.all).toContain('Security layers');
      expect(r.all).not.toContain(standIn);
      const calls = fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '';
      expect(calls, 'no key source was run').not.toMatch(/^(op|infisical|kubectl)/m);
      expect(fs.existsSync(path.join(p.home, '.cache')), 'doctor changes nothing on disk').toBe(false);
      expect(fs.existsSync(p.stagingDir)).toBe(false);
      // Without a slot against dev it says so as a warning (a setup step `run` enforces) and goes on to the other
      // checks; a malformed letter is a failure.
      const noSlot = cli(p, ['doctor', '--target', 'dev', '--offline'], env);
      expect(noSlot.stdout).toMatch(/warn\s+no slot for dev: .*\(`run` refuses until then\)/);
      expect(noSlot.stdout).not.toMatch(/FAIL\s+no slot/);
      expect(noSlot.stdout).toContain('Key source');
      const badSlot = cli(p, ['doctor', '--target', 'dev', '--offline', '--slot', 'AB'], env);
      expect(badSlot.status).toBe(2);
      expect(badSlot.stdout).toMatch(/FAIL\s+the slot must be one lowercase letter/);
    },
    120_000,
  );

  it('reports an env key source as set or not set, never its value', () => {
    const p = project();
    const standIn = 'KIT-DOCTOR-ENV-STANDIN-9a2b';
    const set = cli(p, ['doctor', '--target', 'dev', '--slot', 'e', '--offline', '--native'], {
      CREDLESS_RUNNER_KEY: standIn,
    });
    expect(set.all).toContain('env CREDLESS_RUNNER_KEY (set): set in this environment');
    expect(set.all).not.toContain(standIn);
    const unset = cli(p, ['doctor', '--target', 'dev', '--slot', 'e', '--offline', '--native']);
    expect(unset.all).toContain('env CREDLESS_RUNNER_KEY (not set)');
  }, 120_000);

  it('works without a config and refuses nothing it cannot check', () => {
    const p = project();
    fs.rmSync(p.configFile);
    const r = cli(p, ['doctor', '--offline', '--native']);
    expect(r.stdout).toMatch(/warn\s+no credless\.config\.ts/);
    expect(r.stdout).toContain('Slot');
    expect(r.stdout).not.toContain('Key source');
  }, 120_000);
});

describe('the probe without a key', () => {
  const probeTo = (answers: Record<string, { status: number; body: string } | null>) => async (url: string) => {
    for (const [suffix, answer] of Object.entries(answers)) if (url.endsWith(suffix)) return answer;
    return null;
  };
  const base = (p: TempProject) => ({
    target: 'dev',
    slot: 'e',
    mode: 'native' as const,
    configPath: p.configFile,
    cwd: p.dir,
    env: p.env,
  });

  it('401 is the lock working, 404 is not deployed, unreachable fails', async () => {
    const p = project();
    const ok = await doctor({
      ...base(p),
      probe: probeTo({ '/': { status: 200, body: '<html>' }, '/_test/health': { status: 401, body: '' } }),
    });
    expect(ok.lines.join('\n')).toMatch(/ok\s+test API is on and asks for the key/);
    expect(ok.lines.join('\n')).toMatch(/ok\s+web app answers \(200\)/);
    const gone = await doctor({
      ...base(p),
      probe: probeTo({ '/': { status: 302, body: '' }, '/_test/health': { status: 404, body: '' } }),
    });
    expect(gone.lines.join('\n')).toMatch(/warn\s+test API: no route \(404\)/);
    const down = await doctor({ ...base(p), probe: probeTo({}) });
    expect(down.lines.join('\n')).toMatch(/FAIL\s+web app unreachable/);
    expect(down.lines.join('\n')).toMatch(/FAIL\s+API unreachable/);
  });

  it('a health body answered WITHOUT a key is a broken lock; the body is never printed', async () => {
    const p = project();
    const body = '{"enabled":true,"environment":"dev","keyId":"deadbeef","sinks":{"mail":true}}';
    const broken = await doctor({
      ...base(p),
      probe: probeTo({ '/': { status: 200, body: '' }, '/_test/health': { status: 200, body } }),
    });
    const text = broken.lines.join('\n');
    expect(text).toMatch(/FAIL\s+test API answered its health WITHOUT a key \(200\): lock broken/);
    expect(text).not.toContain('deadbeef');
    expect(broken.failed).toBeGreaterThan(0);
    const other = await doctor({
      ...base(p),
      probe: probeTo({ '/': { status: 200, body: '' }, '/_test/health': { status: 200, body: '<html>ok</html>' } }),
    });
    expect(other.lines.join('\n')).toMatch(/warn\s+test API: 200 without a key/);
  });

  it('is skipped for a local target and under --offline', async () => {
    const p = project();
    let probed = 0;
    const probe = async () => {
      probed += 1;
      return null;
    };
    await doctor({ ...base(p), target: 'selftest', probe });
    await doctor({ ...base(p), offline: true, probe });
    expect(probed).toBe(0);
  });
});
