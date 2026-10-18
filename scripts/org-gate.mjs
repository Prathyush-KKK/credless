#!/usr/bin/env node
// The organisation-string gate (docs/conventions.md §13): fail when any pattern from a private, uncommitted list is
// found in the repository. The list (`.org-gate.local`, one regular expression per line, matched case-insensitively,
// `#` comments and blank lines ignored) names the private origin's product, hosts, address range, people, internal
// document ids, cookie and header names; it never enters the repo. `.org-gate.example` shows the shape.
//
//   node scripts/org-gate.mjs                       # whole repo, patterns from .org-gate.local
//   node scripts/org-gate.mjs --file ~/org.txt      # another pattern file (or ORG_GATE_FILE=...)
//   node scripts/org-gate.mjs docs/research README.md   # only these paths
//   node scripts/org-gate.mjs --strict              # fail (exit 2) when the pattern file is missing
//
// A hit prints `path:line  pattern #n` and never the matched text or the pattern itself, so a CI log of a public
// repository cannot carry the string either. Exit 1 on a hit, 0 when clean or when no pattern file exists (CI has
// none; the maintainers run it locally and in the done check of every task).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'reports',
  '.staging',
  'test-results',
  'playwright-report',
  'blob-report',
]);
const SKIP_FILES = new Set(['pnpm-lock.yaml', '.org-gate.local', '.org-gate.example']);
const MAX_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const options = { file: process.env.ORG_GATE_FILE || '.org-gate.local', strict: false, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') options.file = argv[++i];
    else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length);
    else if (arg === '--strict') options.strict = true;
    else options.paths.push(arg);
  }
  return options;
}

export function loadPatterns(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((source) => new RegExp(source, 'i'));
}

function* walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else if (s.isFile() && !SKIP_FILES.has(name)) {
      yield full;
    }
  }
}

function isText(buffer) {
  const sample = buffer.subarray(0, 8192);
  return !sample.includes(0);
}

/** Returns `[{ file, line, pattern }]`; `pattern` is the 1-based index in the list, never the source. */
export function scan(root, paths, patterns) {
  const hits = [];
  const targets = paths.length > 0 ? paths.map((p) => resolve(root, p)) : [root];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    for (const file of walk(target)) {
      const buffer = readFileSync(file);
      if (buffer.length > MAX_BYTES || !isText(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      lines.forEach((line, index) => {
        patterns.forEach((pattern, p) => {
          if (pattern.test(line)) hits.push({ file: relative(root, file), line: index + 1, pattern: p + 1 });
        });
      });
    }
  }
  return hits;
}

function main() {
  const root = resolve(process.cwd());
  const options = parseArgs(process.argv.slice(2));
  const file = resolve(root, options.file);
  if (!existsSync(file)) {
    console.log(`org-gate: no pattern file at ${relative(root, file) || file}; nothing to check`);
    return options.strict ? 2 : 0;
  }
  const patterns = loadPatterns(readFileSync(file, 'utf8'));
  if (patterns.length === 0) {
    console.log('org-gate: the pattern file is empty; nothing to check');
    return options.strict ? 2 : 0;
  }
  const hits = scan(root, options.paths, patterns);
  if (hits.length === 0) {
    console.log(`org-gate: clean (${patterns.length} patterns)`);
    return 0;
  }
  for (const hit of hits) console.log(`${hit.file}:${hit.line}  pattern #${hit.pattern}`);
  console.log(
    `org-gate: ${hits.length} hit(s); an organisation-specific string is in the repo. A hit is a fix, never an exception.`,
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main());
}
