// scripts/skill-sync.mjs keeps plugins/credless/skills a byte-identical copy of packages/kit/skills; `--check` must
// notice a changed, missing or extra file. scripts/skill-validate.mjs checks the Agent Skills frontmatter rules.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const syncScript = path.join(repo, 'scripts', 'skill-sync.mjs');
const validateScript = path.join(repo, 'scripts', 'skill-validate.mjs');
const kitSkills = path.join(repo, 'packages', 'kit', 'skills');
const pluginSkills = path.join(repo, 'plugins', 'credless', 'skills');

function node(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('skill-sync.mjs', () => {
  let work: string;
  let source: string;
  let target: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'credless-skill-sync-'));
    source = path.join(work, 'source');
    target = path.join(work, 'target');
    cpSync(kitSkills, source, { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('copies the skill and then passes --check', () => {
    const sync = node(syncScript, ['--source', source, '--target', target]);
    expect(sync.code, sync.out).toBe(0);
    expect(existsSync(path.join(target, 'e2e-testing', 'SKILL.md'))).toBe(true);
    expect(readFileSync(path.join(target, 'e2e-testing', 'SKILL.md'))).toEqual(
      readFileSync(path.join(source, 'e2e-testing', 'SKILL.md')),
    );
    const check = node(syncScript, ['--check', '--source', source, '--target', target]);
    expect(check.code, check.out).toBe(0);
    expect(check.out).toContain('matches');
  });

  it('--check fails on a changed file and names it', () => {
    node(syncScript, ['--source', source, '--target', target]);
    writeFileSync(path.join(target, 'e2e-testing', 'references', 'agents.md'), 'drift\n');
    const check = node(syncScript, ['--check', '--source', source, '--target', target]);
    expect(check.code).toBe(1);
    expect(check.out).toContain('e2e-testing/references/agents.md');
    expect(check.out).toContain('skill-sync.mjs');
  });

  it('--check fails on a missing file and on an extra file', () => {
    node(syncScript, ['--source', source, '--target', target]);
    unlinkSync(path.join(target, 'e2e-testing', 'references', 'running.md'));
    expect(node(syncScript, ['--check', '--source', source, '--target', target]).code).toBe(1);
    node(syncScript, ['--source', source, '--target', target]);
    writeFileSync(path.join(target, 'e2e-testing', 'extra.md'), 'not in the source\n');
    const check = node(syncScript, ['--check', '--source', source, '--target', target]);
    expect(check.code).toBe(1);
    expect(check.out).toContain('e2e-testing/extra.md');
  });

  it('--check fails when the target does not exist yet', () => {
    expect(node(syncScript, ['--check', '--source', source, '--target', target]).code).toBe(1);
  });

  it('the repo copy is in sync', () => {
    const check = node(syncScript, ['--check']);
    expect(check.code, check.out).toBe(0);
    expect(existsSync(path.join(pluginSkills, 'e2e-testing', 'SKILL.md'))).toBe(true);
  });
});

describe('skill-validate.mjs', () => {
  it('accepts the kit skill (built-in checks)', () => {
    const result = node(validateScript, ['--builtin-only', path.join(kitSkills, 'e2e-testing')]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('valid');
  });

  it('rejects a name that differs from the directory, an over-long description and an unknown field', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'credless-skill-validate-'));
    try {
      const dir = path.join(work, 'wrong-name');
      cpSync(path.join(kitSkills, 'e2e-testing'), dir, { recursive: true });
      const result = node(validateScript, ['--builtin-only', dir]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('must equal the directory name');

      const dir2 = path.join(work, 'e2e-testing');
      cpSync(path.join(kitSkills, 'e2e-testing'), dir2, { recursive: true });
      const skill = path.join(dir2, 'SKILL.md');
      const text = readFileSync(skill, 'utf8');
      writeFileSync(
        skill,
        text
          .replace(/^description: .*$/m, `description: ${'x'.repeat(1025)}`)
          .replace(/^license: .*$/m, 'license: Apache-2.0\nauthor: nobody'),
      );
      const result2 = node(validateScript, ['--builtin-only', dir2]);
      expect(result2.code).toBe(1);
      expect(result2.out).toContain('1024');
      expect(result2.out).toContain('unknown frontmatter field "author"');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rejects a body over the budget', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'credless-skill-validate-'));
    try {
      const dir = path.join(work, 'e2e-testing');
      cpSync(path.join(kitSkills, 'e2e-testing'), dir, { recursive: true });
      const skill = path.join(dir, 'SKILL.md');
      writeFileSync(skill, `${readFileSync(skill, 'utf8')}${'\nmore\n'.repeat(200)}`);
      const result = node(validateScript, ['--builtin-only', dir]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/budget is 300|limit is 500/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
