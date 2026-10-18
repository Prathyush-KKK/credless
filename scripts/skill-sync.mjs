#!/usr/bin/env node
// The e2e-testing skill has one source: packages/kit/skills (published to npm inside the package, and what
// `npx skills add` fetches). The Claude Code plugin ships a byte-identical copy under plugins/credless/skills, because
// a plugin's skills live inside the plugin folder. This script keeps the copy identical.
//   node scripts/skill-sync.mjs                       copy packages/kit/skills -> plugins/credless/skills
//   node scripts/skill-sync.mjs --check               exit 1 if the copy differs (the repo's check runs this)
//   node scripts/skill-sync.mjs --source d --target d  other directories (the unit test uses this)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : undefined;
}

const source = option('--source') ?? path.join(root, 'packages', 'kit', 'skills');
const target = option('--target') ?? path.join(root, 'plugins', 'credless', 'skills');

/** Every file under `dir`, as sorted relative paths with forward slashes (so the two lists compare on Windows too). */
function list(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function same(rel) {
  const a = path.join(source, rel);
  const b = path.join(target, rel);
  return fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
}

function rel(p) {
  return path.relative(root, p).split(path.sep).join('/') || '.';
}

if (!fs.existsSync(source)) {
  console.error(`skill sync: source ${rel(source)} does not exist`);
  process.exit(2);
}

if (process.argv.includes('--check')) {
  const files = [...new Set([...list(source), ...list(target)])].sort();
  const differ = files.filter((f) => !same(f));
  if (differ.length > 0) {
    console.error(`skill copy out of date (${differ.join(', ')}): run node scripts/skill-sync.mjs`);
    process.exit(1);
  }
  console.log(`skill check: ${rel(target)} matches ${rel(source)} (${files.length} files)`);
} else {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`synced ${list(target).length} files to ${rel(target)}`);
}
