// `writeTemplates` (src/templates/index.ts): what `credless init` writes into a project. The written config must be
// valid TypeScript whose object passes the kit's zod schema (config/schema.ts, Task 1); until that file lands, the
// test evaluates the config in a child Node process and checks its shape.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_NAME } from '../../src/brand.ts';
import {
  AGENTS_MARKER,
  DEFAULT_ANSWERS,
  fillTemplate,
  listTemplates,
  resolveAnswers,
  templatesDir,
  writeTemplates,
} from '../../src/templates/index.ts';
import type { KitConfig } from '../../src/types.ts';

const configFile = `${CLI_NAME}.config.ts`;
const schemaPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/config/schema.ts');

/** Evaluate the written config in a child Node process (type stripping is native) with `defineConfig` as identity. */
function evaluateConfig(dir: string): KitConfig {
  const shim = path.join(dir, 'config-shim.mjs');
  writeFileSync(shim, 'export const defineConfig = (config) => config;\n');
  const original = readFileSync(path.join(dir, configFile), 'utf8');
  const rewritten = original.replace(`'${CLI_NAME}/config'`, "'./config-shim.mjs'");
  expect(rewritten).not.toBe(original);
  const evalFile = path.join(dir, 'config-under-test.ts');
  writeFileSync(evalFile, rewritten);
  const script = `const m = await import(${JSON.stringify(pathToFileURL(evalFile).href)}); process.stdout.write(JSON.stringify(m.default));`;
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, `${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as KitConfig;
}

async function validateWithSchema(config: KitConfig): Promise<'schema' | 'shape'> {
  if (existsSync(schemaPath)) {
    const module = (await import(pathToFileURL(schemaPath).href)) as Record<string, unknown>;
    const schema = module.kitConfigSchema as
      | { safeParse?: (v: unknown) => { success: boolean; error?: unknown } }
      | undefined;
    if (schema?.safeParse) {
      const parsed = schema.safeParse(config);
      expect(parsed.success, JSON.stringify(parsed.error, null, 2)).toBe(true);
      return 'schema';
    }
  }
  // Task 1's schema is not here yet: the structural checks below stand in for it.
  return 'shape';
}

describe('listTemplates', () => {
  it('names eight templates that all exist', () => {
    const entries = listTemplates();
    expect(entries.map((e) => e.destination)).toEqual([
      configFile,
      'playwright.config.ts',
      'personas.yaml',
      'e2e/example.spec.ts',
      'AGENTS.md',
      '.cursor/rules/e2e-testing.mdc',
      '.github/workflows/e2e.yml',
      '.claude/credless-settings.snippet.json',
    ]);
    const dir = templatesDir();
    for (const entry of entries) expect(existsSync(path.join(dir, entry.source)), entry.source).toBe(true);
  });
});

describe('resolveAnswers', () => {
  it('fills defaults and refuses production names, bad targets and bad origins', () => {
    expect(resolveAnswers()).toEqual(DEFAULT_ANSWERS);
    expect(resolveAnswers({ web: 'https://dev.app.example/' }).web).toBe('https://dev.app.example');
    expect(() => resolveAnswers({ target: 'prod' })).toThrow(/production/);
    expect(() => resolveAnswers({ target: 'pre-production' })).toThrow(/production/);
    expect(() => resolveAnswers({ target: 'Staging' })).toThrow(/must match/);
    expect(() => resolveAnswers({ target: 'a b' })).toThrow(/must match/);
    expect(() => resolveAnswers({ web: 'app.example' })).toThrow(/not a URL/);
    expect(() => resolveAnswers({ api: 'ftp://api.example' })).toThrow(/http or https/);
    expect(() => resolveAnswers({ api: 'https://user:pw@api.example' })).toThrow(/credentials/);
  });
});

describe('fillTemplate', () => {
  it('replaces the origins before the target word, so a given origin is never rewritten', () => {
    const text = "staging: { web: 'https://app.staging.example', api: 'https://api.staging.example' } --target staging";
    const out = fillTemplate(text, {
      target: 'dev',
      web: 'https://staging-app.example',
      api: 'https://api.dev.example',
    });
    expect(out).toBe("dev: { web: 'https://staging-app.example', api: 'https://api.dev.example' } --target dev");
  });
});

describe('writeTemplates', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'credless-init-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every template into an empty directory and the config parses', async () => {
    const result = await writeTemplates(dir);
    expect(result.written).toHaveLength(8);
    expect(result.skipped).toEqual([]);
    expect(result.appended).toEqual([]);
    for (const entry of listTemplates())
      expect(existsSync(path.join(dir, entry.destination)), entry.destination).toBe(true);

    const config = evaluateConfig(dir);
    const how = await validateWithSchema(config);
    expect(config.targets.staging).toEqual({ web: DEFAULT_ANSWERS.web, api: DEFAULT_ANSWERS.api });
    expect(config.production.domains).toEqual(['example.com']);
    expect(config.personas.catalog).toBe('./personas.yaml');
    expect(new RegExp(config.personas.addressPattern).test('qa+a0-owner@example.com')).toBe(true);
    expect(config.key).toEqual({ source: 'env' });
    expect(config.evidence?.reportsDir).toBe('reports');
    // the config names no value: the key source is a reference, and nothing else looks like a credential
    const text = readFileSync(path.join(dir, configFile), 'utf8');
    expect(text).not.toMatch(/(password|token|secret)\s*:\s*['"][^'"]+['"]/i);
    if (how === 'shape') console.warn('config/schema.ts not present yet: the config was checked by shape only');
  });

  it('fills the target name and the origins everywhere they belong', async () => {
    await writeTemplates(dir, { target: 'dev', web: 'https://dev.app.example', api: 'https://dev.api.example' });
    const config = readFileSync(path.join(dir, configFile), 'utf8');
    expect(config).toContain("dev: { web: 'https://dev.app.example', api: 'https://dev.api.example' }");
    expect(config).not.toMatch(/\bstaging\b/);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('--target dev');
    const workflow = readFileSync(path.join(dir, '.github/workflows/e2e.yml'), 'utf8');
    expect(workflow).toContain('target: dev');
    expect(workflow).toContain('environment: dev');
    expect(readFileSync(path.join(dir, '.cursor/rules/e2e-testing.mdc'), 'utf8')).toContain('--target dev');
    const evaluated = evaluateConfig(dir);
    expect(Object.keys(evaluated.targets)).toEqual(['dev']);
  });

  it('skips existing files and appends the AGENTS.md snippet once', async () => {
    writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nRules.\n');
    writeFileSync(path.join(dir, 'personas.yaml'), 'version: 1\n');
    const first = await writeTemplates(dir);
    expect(first.appended).toEqual(['AGENTS.md']);
    expect(first.skipped).toEqual(['personas.yaml']);
    expect(readFileSync(path.join(dir, 'personas.yaml'), 'utf8')).toBe('version: 1\n');
    const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# My project')).toBe(true);
    expect(agents).toContain(AGENTS_MARKER);

    const second = await writeTemplates(dir);
    expect(second.written).toEqual([]);
    expect(second.appended).toEqual([]);
    expect(second.skipped).toHaveLength(8);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(agents);
  });

  it('the settings snippet is valid JSON with deny rules only', async () => {
    await writeTemplates(dir);
    const snippet = JSON.parse(readFileSync(path.join(dir, '.claude/credless-settings.snippet.json'), 'utf8')) as {
      permissions: { deny: string[]; allow?: unknown };
    };
    expect(snippet.permissions.allow).toBeUndefined();
    expect(snippet.permissions.deny).toContain('Read(~/.cache/credless/**)');
    expect(snippet.permissions.deny).toContain('Bash(printenv:*)');
    expect(snippet.permissions.deny.every((rule) => /^(Read|Bash)\(/.test(rule))).toBe(true);
  });
});
