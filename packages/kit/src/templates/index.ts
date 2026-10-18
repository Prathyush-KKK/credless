// What `credless init` writes (plan §4.4, §7): the files under the package's `templates/` directory, copied into the
// consumer's project with the target name and origins filled in. The CLI's `init` command (runner/init.ts, Task 4)
// calls `writeTemplates`; `listTemplates` is for `init --dry-run` and the docs.
//
// The templates live inside the package (`<package>/templates`, published with it); `templatesDir()` also accepts a
// `templates/` at the workspace root, should they ever move back. Nothing here reads or writes a secret: the config
// template names a key SOURCE, never a value.
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAME, KIT_NAME } from '../brand.ts';

/** How one template lands in the project. */
export interface TemplateEntry {
  /** path under `templates/` */
  source: string;
  /** path under the project directory */
  destination: string;
  /** `create` skips an existing file; `append` adds the template (once, by marker) to an existing file */
  mode: 'create' | 'append';
  /** text templates get the answers filled in; others are copied byte for byte */
  fill: boolean;
}

/** What `init` learned from its prompts (or `--yes` defaults). */
export interface InitAnswers {
  /** the target name, `^[a-z][a-z0-9-]{0,31}$`, never a production word; default `staging` */
  target?: string;
  /** the web app's origin for that target; default `https://app.staging.example` */
  web?: string;
  /** the backend's origin for that target; default `https://api.staging.example` */
  api?: string;
}

export interface WriteResult {
  /**
   * `esm` when the project's nearest package.json says `"type": "module"`, else `commonjs`. In a CommonJS project the
   * TypeScript files are written as `.mts`: Node and Playwright compile a `.ts` there as CommonJS, where the
   * config's `import.meta` and the kit's ES modules fail, while `.mts` is an ES module in any project.
   */
  moduleType: 'esm' | 'commonjs';
  /** files created, relative to the project directory */
  written: string[];
  /** files that existed and were left alone */
  skipped: string[];
  /** files the snippet was appended to */
  appended: string[];
  /** the directory the templates were read from */
  templatesDir: string;
}

/** The marker the AGENTS.md snippet carries, so `init` appends it at most once. */
export const AGENTS_MARKER = `<!-- ${KIT_NAME}:`;

export const DEFAULT_ANSWERS: Required<InitAnswers> = {
  target: 'staging',
  web: 'https://app.staging.example',
  api: 'https://api.staging.example',
};

const CONFIG_FILE = `${CLI_NAME}.config.ts`;
const SETTINGS_SNIPPET = `${KIT_NAME}-settings.snippet.json`;

const ENTRIES: readonly TemplateEntry[] = [
  { source: CONFIG_FILE, destination: CONFIG_FILE, mode: 'create', fill: true },
  // the kit's reporters, global setup and no retries, through `kitPlaywrightConfig`; nothing in it is project-specific
  { source: 'playwright.config.ts', destination: 'playwright.config.ts', mode: 'create', fill: false },
  { source: 'personas.yaml', destination: 'personas.yaml', mode: 'create', fill: true },
  { source: 'e2e/example.spec.ts', destination: 'e2e/example.spec.ts', mode: 'create', fill: true },
  { source: 'AGENTS.md', destination: 'AGENTS.md', mode: 'append', fill: true },
  { source: '.cursor/rules/e2e-testing.mdc', destination: '.cursor/rules/e2e-testing.mdc', mode: 'create', fill: true },
  { source: '.github/workflows/e2e.yml', destination: '.github/workflows/e2e.yml', mode: 'create', fill: true },
  { source: 'claude-settings.snippet.json', destination: `.claude/${SETTINGS_SNIPPET}`, mode: 'create', fill: false },
];

/** The templates `init` writes, in order. */
export function listTemplates(): TemplateEntry[] {
  return ENTRIES.map((entry) => ({ ...entry }));
}

/** The nearest ancestor of `from` whose package.json names the kit (the published `templates/` and `demo/` sit there). */
export function packageRoot(from: string): string {
  let dir = from;
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === KIT_NAME)
          return dir;
      } catch {
        // not ours; keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${KIT_NAME}: cannot find the package root above ${from}`);
    dir = parent;
  }
}

/** Where the templates are: `<package>/templates` (published) or `<workspace>/templates` (development). */
export function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = packageRoot(here);
  const candidates = [path.join(root, 'templates'), path.join(root, '..', '..', 'templates')];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, CONFIG_FILE))) return candidate;
  }
  throw new Error(`${KIT_NAME}: templates not found (looked in ${candidates.join(', ')})`);
}

const TARGET_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

/** Check the answers the way the config loader will, so `init` fails here and not at the first run. */
export function resolveAnswers(answers: InitAnswers = {}): Required<InitAnswers> {
  const target = answers.target ?? DEFAULT_ANSWERS.target;
  if (!TARGET_SHAPE.test(target)) {
    throw new Error(
      `${KIT_NAME} init: target "${target}" must match ${TARGET_SHAPE} (lowercase letters, digits, hyphens)`,
    );
  }
  if (/prod/.test(target)) {
    throw new Error(
      `${KIT_NAME} init: "${target}" names production; a target is dev, staging or local, never production`,
    );
  }
  const web = origin(answers.web ?? DEFAULT_ANSWERS.web, 'web');
  const api = origin(answers.api ?? DEFAULT_ANSWERS.api, 'api');
  return { target, web, api };
}

function origin(value: string, which: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${KIT_NAME} init: ${which} "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${KIT_NAME} init: ${which} "${value}" must be http or https`);
  }
  if (url.username || url.password) throw new Error(`${KIT_NAME} init: ${which} must not carry credentials`);
  if (/['"\\\n\r]/.test(value)) throw new Error(`${KIT_NAME} init: ${which} contains a quote or a line break`);
  return url.origin;
}

/**
 * Fill a template: the default origins are swapped for placeholders first, the default target name is replaced
 * wherever it stands as a word, and the given origins go in last, so an origin that itself contains the word
 * `staging` is never rewritten. The templates use `staging` only where the target name belongs.
 */
export function fillTemplate(text: string, answers: Required<InitAnswers>): string {
  const WEB = '\u0000web\u0000';
  const API = '\u0000api\u0000';
  let out = text.split(DEFAULT_ANSWERS.web).join(WEB).split(DEFAULT_ANSWERS.api).join(API);
  if (answers.target !== DEFAULT_ANSWERS.target) {
    out = out.replace(new RegExp(`\\b${DEFAULT_ANSWERS.target}\\b`, 'g'), answers.target);
  }
  return out.split(WEB).join(answers.web).split(API).join(answers.api);
}

/** `esm` when the nearest package.json at or above `dir` says `"type": "module"`; `commonjs` otherwise (Node's rule). */
export function projectModuleType(dir: string): 'esm' | 'commonjs' {
  let current = path.resolve(dir);
  for (;;) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'module'
          ? 'esm'
          : 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return 'commonjs';
    current = parent;
  }
}

/** The TypeScript files `init` writes, as the templates name them. */
const TS_FILES = [CONFIG_FILE, 'playwright.config.ts', 'example.spec.ts'];

/** A destination and the text of the templates spelled for a CommonJS project: `.mts` for the TypeScript files. */
function forCommonJs(text: string): string {
  let out = text;
  for (const name of TS_FILES) out = out.split(name).join(`${name.slice(0, -3)}.mts`);
  return out;
}

/** Write the templates into `dir`. Existing files are skipped (AGENTS.md gets the snippet appended once). */
export async function writeTemplates(dir: string, answers: InitAnswers = {}): Promise<WriteResult> {
  const resolved = resolveAnswers(answers);
  const from = templatesDir();
  const moduleType = projectModuleType(dir);
  const result: WriteResult = { moduleType, written: [], skipped: [], appended: [], templatesDir: from };
  for (const entry of ENTRIES) {
    const sourcePath = path.join(from, entry.source);
    const destination = moduleType === 'commonjs' ? forCommonJs(entry.destination) : entry.destination;
    const destinationPath = path.join(dir, destination);
    const raw = await readFile(sourcePath);
    let content: string | Buffer = entry.fill ? fillTemplate(raw.toString('utf8'), resolved) : raw;
    if (moduleType === 'commonjs' && typeof content === 'string') content = forCommonJs(content);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    // A project that already has the other spelling of a TypeScript file keeps it: never two configs side by side.
    const otherSpelling = /\.m?ts$/.test(destination)
      ? path.join(
          dir,
          destination.endsWith('.mts') ? `${destination.slice(0, -4)}.ts` : `${destination.slice(0, -3)}.mts`,
        )
      : null;
    if (otherSpelling && existsSync(otherSpelling)) {
      result.skipped.push(path.relative(dir, otherSpelling));
      continue;
    }
    if (!existsSync(destinationPath)) {
      await writeFile(destinationPath, content, { flag: 'wx' });
      result.written.push(destination);
      continue;
    }
    if (entry.mode === 'append') {
      const existing = await readFile(destinationPath, 'utf8');
      if (existing.includes(AGENTS_MARKER)) {
        result.skipped.push(entry.destination);
        continue;
      }
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      await appendFile(destinationPath, `${separator}${content.toString()}`);
      result.appended.push(destination);
      continue;
    }
    result.skipped.push(destination);
  }
  return result;
}
