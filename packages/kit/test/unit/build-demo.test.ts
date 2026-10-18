// The demo's e2e project as the package ships it (scripts/build-demo.ts): the workspace's paths into the kit become the
// package's specifiers, `workspace-only` blocks are dropped, and a path into the workspace that survives fails the
// build. The real apps/demo files are converted too, so an edit there that the package could not resolve fails here,
// before a build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emitProject, packageCopy } from '../../scripts/build-demo.ts';
import { KIT_ROOT } from './helpers/tmp-project.ts';

const DEMO = path.resolve(KIT_ROOT, '..', '..', 'apps', 'demo');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('packageCopy', () => {
  it('rewrites the specifiers into the kit and drops the marked blocks, in TypeScript and YAML', () => {
    const ts = [
      "import { defineConfig } from '../../../packages/kit/src/config/index.ts';",
      "import { Control } from '../../../packages/kit/src/adapters/index.ts';",
      '// workspace-only:start',
      "import { standaloneDemo } from '../../../packages/kit/test/helpers/demo-server.ts';",
      '// workspace-only:end',
      'export default defineConfig({',
      '  // workspace-only:start',
      '  ...standaloneDemo(),',
      '  // workspace-only:end',
      '});',
    ].join('\n');
    expect(packageCopy(ts, 'x.ts')).toBe(
      [
        "import { defineConfig } from 'credless/config';",
        "import { Control } from 'credless/adapters';",
        'export default defineConfig({',
        '});',
      ].join('\n'),
    );
    const yaml = ['# workspace-only:start', '# $schema=../../../schema.json', '# workspace-only:end', 'version: 1'];
    expect(packageCopy(yaml.join('\n'), 'x.yaml')).toBe('version: 1');
  });

  it('fails on an unbalanced marker and on a workspace path that survives', () => {
    expect(() => packageCopy('// workspace-only:start\nx', 'a.ts')).toThrow(/no end marker/);
    expect(() => packageCopy('// workspace-only:end', 'b.ts')).toThrow(/unbalanced/);
    expect(() => packageCopy('// workspace-only:start\n// workspace-only:start', 'c.ts')).toThrow(/unbalanced/);
    expect(() => packageCopy("import x from '../../../packages/kit/src/types.ts';", 'd.ts')).toThrow(
      /d\.ts: a path into the workspace survives/,
    );
  });
});

describe('emitProject', () => {
  it('converts the real demo project: no workspace path left, the plant spec and the contract included', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-demo-project-'));
    dirs.push(out);
    const files = emitProject(out, DEMO);
    expect(files).toEqual(
      expect.arrayContaining([
        'e2e/credless.config.mts',
        'e2e/playwright.config.mts',
        'e2e/personas.yaml',
        'e2e/demo.control.mts',
        'e2e/fixtures.mts',
        'e2e/plant-secret.spec.mts',
        'e2e/sign-in.spec.mts',
        'contract/demo.openapi.yaml',
        'package.json',
      ]),
    );
    for (const file of files) {
      const text = fs.readFileSync(path.join(out, file), 'utf8');
      expect(text, file).not.toMatch(/\.\.\/\.\.\/\.\.\/|workspace-only/);
    }
    const config = fs.readFileSync(path.join(out, 'e2e', 'credless.config.mts'), 'utf8');
    expect(config).toContain("from 'credless/config'");
    expect(config).toContain("'./demo.control.mts'");
    expect(config).not.toMatch(/['"]\.\.?\/[^'"]+\.ts['"]/);
    expect(fs.readFileSync(path.join(out, 'e2e', 'playwright.config.mts'), 'utf8')).not.toContain('standaloneDemo');
    expect(files.some((file) => file.endsWith('.ts'))).toBe(false);
    // no "type": the .mts files are ES modules on their own, as in a user's CommonJS project
    expect(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).type).toBeUndefined();
  });
});
