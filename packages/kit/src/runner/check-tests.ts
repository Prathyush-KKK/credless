// The test-code lint gate (plan §6 F3): test files get their browsers, their network and their secrets from the
// kit's fixtures and nothing else. The gate forbids, in a test directory, launching or connecting browsers, opening
// contexts, proxy and launch options, Node's network, process and file-system modules, `process`, bare `fetch` and
// dynamic code. It walks the TypeScript AST when the `typescript` package can be imported (a devDependency here;
// the consumer's own copy in a project) and falls back to a comment-stripping tokenizer otherwise, so the same
// rules hold in both engines; the AST engine is the authoritative one.
import fs from 'node:fs';
import path from 'node:path';

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

export type Engine = 'ts' | 'regex';

export interface CheckResult {
  engine: Engine;
  files: number;
  findings: Finding[];
}

export interface CheckOptions {
  /** force an engine (tests run both) */
  engine?: Engine | 'auto';
  cwd?: string;
}

const NODE_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'child_process',
  'fs',
  'fs/promises',
  'dns',
  'vm',
  'worker_threads',
];
const BROWSER_PACKAGES = [
  'playwright',
  'playwright-core',
  '@playwright/browser-chromium',
  '@playwright/browser-firefox',
  '@playwright/browser-webkit',
];
const BROWSER_NAMES = new Set(['chromium', 'firefox', 'webkit', 'request', '_electron', '_android']);
const LAUNCH_METHODS = new Set([
  'launch',
  'launchPersistentContext',
  'launchServer',
  'connectOverCDP',
  'newContext',
  'newBrowserCDPSession',
]);
const CONNECT_RECEIVERS = new Set(['chromium', 'firefox', 'webkit', '_electron', '_android']);
// `egressLookup` is the kit's own self-test option (a resolver for the persona proxies): never in a real suite.
const OPTION_NAMES = new Set([
  'launchOptions',
  'proxy',
  'ignoreDefaultArgs',
  'executablePath',
  'connectOptions',
  'egressLookup',
]);
const PROCESS_NAMES = new Set(['process']);
const TEST_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
// A `*.config.*` beside the tests (the kit's, Playwright's) reads the harness's environment by design: a directory
// walk leaves it out; a config file named on the command line is checked like any other.
const CONFIG_FILE = /\.config\.(?:[cm]?[jt]s)$/;

export const RULES = {
  'module-import':
    'Test code reaches the network, the file system and other processes only through the kit; this module is off limits.',
  'browser-import': "Browsers come from the kit's fixtures (personas.open), never from Playwright directly.",
  'browser-launch': "Launching or connecting a browser, or opening a context, bypasses the persona's proxy and guard.",
  'launch-option': "Launch, proxy and connect options are the kit's to set: they decide where traffic goes.",
  process: "Test code reads no environment and touches no process: the kit's config carries what a test needs.",
  'bare-fetch':
    "A bare fetch() or WebSocket from a test bypasses the persona's egress proxy; use session.api() or the browser.",
  'dynamic-code': 'eval() and new Function() hide what a test does from this gate.',
} as const;

export type RuleName = keyof typeof RULES;

function moduleRule(specifier: string): RuleName | null {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (NODE_MODULES.includes(bare)) return 'module-import';
  if (BROWSER_PACKAGES.includes(specifier)) return 'browser-import';
  return null;
}

/** Every test file under the directories (or the files) given, node_modules skipped. */
export function listTestFiles(targets: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts') && !CONFIG_FILE.test(entry.name))
        out.push(full);
    }
  };
  for (const target of targets) {
    const full = path.resolve(cwd, target);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else out.push(full);
  }
  return out.sort();
}

// --- the AST engine -------------------------------------------------------------------------------------------

type Ts = typeof import('typescript');

/** What the AST engine calls. TypeScript 7 ships no stable compiler API yet: a copy without these counts as absent. */
const TS_FUNCTIONS = [
  'createSourceFile',
  'forEachChild',
  'isCallExpression',
  'isElementAccessExpression',
  'isExportDeclaration',
  'isIdentifier',
  'isImportDeclaration',
  'isMethodDeclaration',
  'isNamedImports',
  'isNewExpression',
  'isPropertyAccessExpression',
  'isPropertyAssignment',
  'isShorthandPropertyAssignment',
  'isStringLiteral',
  'isStringLiteralLike',
] as const;
const TS_ENUMS = ['ScriptKind', 'ScriptTarget', 'SyntaxKind'] as const;

/** The module as the AST engine's `ts`, or null when it lacks the compiler API (absent, or TypeScript 7). */
export function usableTypescript(mod: unknown): Ts | null {
  const m = mod as ({ default?: unknown } & Record<string, unknown>) | null | undefined;
  const ts = (m?.default ?? m) as Record<string, unknown> | null | undefined;
  if (!ts) return null;
  const complete =
    TS_FUNCTIONS.every((name) => typeof ts[name] === 'function') &&
    TS_ENUMS.every((name) => typeof ts[name] === 'object' && ts[name] !== null);
  return complete ? (ts as unknown as Ts) : null;
}

async function loadTypescript(): Promise<Ts | null> {
  try {
    return usableTypescript(await import('typescript'));
  } catch {
    return null;
  }
}

function checkWithTs(ts: Ts, file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const report = (node: import('typescript').Node, rule: RuleName, detail: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: line + 1, column: character + 1, rule, message: `${detail}: ${RULES[rule]}` });
  };
  const checkSpecifier = (
    node: import('typescript').Node,
    specifier: string,
    bindings?: import('typescript').NamedImportBindings,
  ) => {
    const rule = moduleRule(specifier);
    if (rule) report(node, rule, `import of ${specifier}`);
    if (specifier === '@playwright/test' && bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (BROWSER_NAMES.has(name)) report(el, 'browser-import', `import of ${name} from @playwright/test`);
      }
    }
  };
  const visit = (node: import('typescript').Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node, node.moduleSpecifier.text, node.importClause?.namedBindings);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) {
        checkSpecifier(node, arg.text);
      } else if (ts.isIdentifier(callee)) {
        if (callee.text === 'require' && arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text);
        else if (callee.text === 'fetch') report(node, 'bare-fetch', 'fetch()');
        else if (callee.text === 'eval') report(node, 'dynamic-code', 'eval()');
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const receiver = ts.isIdentifier(callee.expression) ? callee.expression.text : null;
        if (LAUNCH_METHODS.has(method)) report(node, 'browser-launch', `.${method}()`);
        else if (method === 'connect' && receiver && CONNECT_RECEIVERS.has(receiver))
          report(node, 'browser-launch', `${receiver}.connect()`);
        else if (method === 'fetch' && (receiver === 'globalThis' || receiver === 'window' || receiver === 'self')) {
          report(node, 'bare-fetch', `${receiver}.fetch()`);
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'Function') report(node, 'dynamic-code', 'new Function()');
      if (node.expression.text === 'WebSocket') report(node, 'bare-fetch', 'new WebSocket()');
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PROCESS_NAMES.has(node.expression.text)
    ) {
      report(node, 'process', `process.${node.name.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PROCESS_NAMES.has(node.expression.text)
    ) {
      report(node, 'process', 'process[...]');
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      PROCESS_NAMES.has(node.name.text)
    ) {
      report(node, 'process', 'globalThis.process');
    } else if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = node.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
      if (key && OPTION_NAMES.has(key)) report(node, 'launch-option', `option ${key}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

// --- the fallback engine --------------------------------------------------------------------------------------

/**
 * Replace comments with spaces (newlines kept), leaving string and template contents alone; with `strings`, blank
 * the contents of strings and templates too (the quotes stay), so a word inside a string is not a finding.
 */
export function stripComments(text: string, options: { strings?: boolean } = {}): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let quote: string | null = null;
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (quote) {
      if (c === '\\' && i + 1 < n) {
        out += options.strings ? '  ' : c + next;
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
      } else out += options.strings && c !== '\n' ? ' ' : c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i += 1) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const SPECIFIER = `['"]([^'"]+)['"]`;
const REGEX_RULES: Array<{ pattern: RegExp; rule: RuleName | 'specifier'; detail: (m: RegExpExecArray) => string }> = [
  {
    pattern: new RegExp(String.raw`\b(?:from|import|require)\s*\(?\s*${SPECIFIER}`, 'g'),
    rule: 'specifier',
    detail: (m) => m[1] ?? '',
  },
  {
    pattern: /\bimport\s*\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]/g,
    rule: 'browser-import',
    detail: (m) => m[1] ?? '',
  },
  {
    pattern: /\.(launch|launchPersistentContext|launchServer|connectOverCDP|newContext|newBrowserCDPSession)\s*\(/g,
    rule: 'browser-launch',
    detail: (m) => `.${m[1]}()`,
  },
  {
    pattern: /\b(chromium|firefox|webkit|_electron|_android)\.connect\s*\(/g,
    rule: 'browser-launch',
    detail: (m) => `${m[1]}.connect()`,
  },
  {
    pattern: /(?:^|[^.\w$])(launchOptions|proxy|ignoreDefaultArgs|executablePath|connectOptions|egressLookup)\s*[:,}]/g,
    rule: 'launch-option',
    detail: (m) => `option ${m[1]}`,
  },
  {
    pattern: /(?:^|[^.\w$])process\s*(?:\.\s*(\w+)|\[)/g,
    rule: 'process',
    detail: (m) => `process.${m[1] ?? '[...]'}`,
  },
  { pattern: /\bglobalThis\s*\.\s*process\b/g, rule: 'process', detail: () => 'globalThis.process' },
  { pattern: /(?:^|[^.\w$])fetch\s*\(/g, rule: 'bare-fetch', detail: () => 'fetch()' },
  {
    pattern: /\b(?:globalThis|window|self)\s*\.\s*fetch\s*\(/g,
    rule: 'bare-fetch',
    detail: () => 'globalThis.fetch()',
  },
  { pattern: /\bnew\s+WebSocket\s*\(/g, rule: 'bare-fetch', detail: () => 'new WebSocket()' },
  { pattern: /(?:^|[^.\w$])eval\s*\(/g, rule: 'dynamic-code', detail: () => 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/g, rule: 'dynamic-code', detail: () => 'new Function()' },
];

function checkWithRegex(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  // Specifiers are string literals, so that pass keeps strings; every other pass sees them blanked.
  const withStrings = stripComments(text);
  const blanked = stripComments(text, { strings: true });
  const lineOf = (index: number) => {
    const before = blanked.slice(0, index);
    const line = before.split('\n').length;
    const column = index - before.lastIndexOf('\n');
    return { line, column };
  };
  for (const { pattern, rule, detail } of REGEX_RULES) {
    const code = rule === 'specifier' || rule === 'browser-import' ? withStrings : blanked;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
      const at = lineOf(m.index + (m[0].length - m[0].trimStart().length));
      if (rule === 'specifier') {
        const specifier = detail(m);
        const r = moduleRule(specifier);
        if (r) findings.push({ file, ...at, rule: r, message: `import of ${specifier}: ${RULES[r]}` });
        continue;
      }
      if (rule === 'browser-import') {
        const names = (m[1] ?? '').split(',').map(
          (s) =>
            s
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '',
        );
        for (const name of names) {
          if (BROWSER_NAMES.has(name))
            findings.push({ file, ...at, rule, message: `import of ${name} from @playwright/test: ${RULES[rule]}` });
        }
        continue;
      }
      findings.push({ file, ...at, rule, message: `${detail(m)}: ${RULES[rule]}` });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Check the test files under `targets`. Findings carry file, line and the reason; never the file's contents. */
export async function checkTests(targets: string[], options: CheckOptions = {}): Promise<CheckResult> {
  const files = listTestFiles(targets, options.cwd);
  const ts = options.engine === 'regex' ? null : await loadTypescript();
  if (options.engine === 'ts' && !ts) {
    throw new Error(
      'the ts engine needs the typescript package with its compiler API: it is not installed, or it is TypeScript 7, which has none yet (--engine regex works without it)',
    );
  }
  const findings: Finding[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    findings.push(...(ts ? checkWithTs(ts, file, text) : checkWithRegex(file, text)));
  }
  return { engine: ts ? 'ts' : 'regex', files: files.length, findings };
}

/** `file:line:col: rule: message`, the way editors parse it. */
export function formatFinding(f: Finding, cwd = process.cwd()): string {
  return `${path.relative(cwd, f.file) || f.file}:${f.line}:${f.column}: ${f.rule}: ${f.message}`;
}
