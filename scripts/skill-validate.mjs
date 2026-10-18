#!/usr/bin/env node
// Validates the kit's skills against the Agent Skills spec (agentskills.io) and the kit's own budgets, without
// dependencies: `skills-ref` (the reference validator) is tried through npx when the network allows, and the built-in
// checks run always, so CI has one answer either way.
//   node scripts/skill-validate.mjs                      every skill under packages/kit/skills and plugins/credless/skills
//   node scripts/skill-validate.mjs <skill dir>...       these directories
//   --builtin-only                                       skip the npx attempt (offline CI, the unit test)
//   --max-body-lines <n>                                 the kit's SKILL.md body budget (default 300; the spec's hard limit is 500)
//   --max-reference-lines <n>                            budget per references/*.md (default 400)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const builtinOnly = argv.includes('--builtin-only');
const MAX_BODY = flag('--max-body-lines', 300);
const MAX_REFERENCE = flag('--max-reference-lines', 400);
const SPEC_MAX_BODY = 500;
const KNOWN_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

function skillDirs() {
  const explicit = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--max')));
  if (explicit.length > 0) return explicit.map((d) => path.resolve(d));
  const out = [];
  for (const parent of [
    path.join(root, 'packages', 'kit', 'skills'),
    path.join(root, 'plugins', 'credless', 'skills'),
  ]) {
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(path.join(parent, entry.name));
    }
  }
  return out;
}

/** The YAML subset a SKILL.md frontmatter uses: scalars, one level of nested maps, flow maps, block scalars. */
function parseFrontmatter(text) {
  const lines = text.split('\n');
  const map = {};
  const errors = [];
  let i = 0;
  const unquote = (v) => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  };
  const flowMap = (v) => {
    const inner = v.trim().slice(1, -1).trim();
    const out = {};
    if (!inner) return out;
    for (const part of inner.split(',')) {
      const m = part.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) errors.push(`cannot parse flow map entry "${part.trim()}"`);
      else out[m[1]] = unquote(m[2]);
    }
    return out;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) {
      errors.push(`cannot parse frontmatter line "${line}"`);
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '') {
      // a nested block map
      const nested = {};
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        const n = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!n) errors.push(`cannot parse nested line "${lines[i]}"`);
        else nested[n[1]] = unquote(n[2]);
        i++;
      }
      map[key] = nested;
      continue;
    }
    if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
      const block = [];
      i++;
      while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
        block.push(lines[i].trim());
        i++;
      }
      map[key] = rest.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
      continue;
    }
    map[key] = rest.startsWith('{') && rest.endsWith('}') ? flowMap(rest) : unquote(rest);
    i++;
  }
  return { map, errors };
}

function validateSkill(dir) {
  const problems = [];
  const warnings = [];
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return { problems: [`${dir}: no SKILL.md`], warnings };
  const text = fs.readFileSync(skillFile, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) return { problems: [`${skillFile}: no YAML frontmatter between --- lines at the top`], warnings };
  const { map, errors } = parseFrontmatter(fm[1]);
  problems.push(...errors.map((e) => `${skillFile}: ${e}`));
  const body = fm[2];

  for (const key of Object.keys(map)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${skillFile}: unknown frontmatter field "${key}"`);
  }
  const name = map.name;
  const dirName = path.basename(dir);
  if (typeof name !== 'string' || name.length === 0) problems.push(`${skillFile}: name is required`);
  else {
    if (name.length > 64) problems.push(`${skillFile}: name is ${name.length} characters; the limit is 64`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      problems.push(`${skillFile}: name "${name}" must be lowercase letters, digits and single hyphens`);
    if (name !== dirName) problems.push(`${skillFile}: name "${name}" must equal the directory name "${dirName}"`);
  }
  const description = map.description;
  if (typeof description !== 'string' || description.trim().length === 0)
    problems.push(`${skillFile}: description is required`);
  else if (description.length > 1024)
    problems.push(`${skillFile}: description is ${description.length} characters; the limit is 1024`);
  if (map.compatibility !== undefined) {
    if (typeof map.compatibility !== 'string') problems.push(`${skillFile}: compatibility must be a string`);
    else if (map.compatibility.length > 500)
      problems.push(`${skillFile}: compatibility is ${map.compatibility.length} characters; the limit is 500`);
  }
  if (map.license !== undefined && typeof map.license !== 'string')
    problems.push(`${skillFile}: license must be a string`);
  if (map.metadata !== undefined) {
    if (typeof map.metadata !== 'object') problems.push(`${skillFile}: metadata must be a map`);
    else
      for (const [k, v] of Object.entries(map.metadata))
        if (typeof v !== 'string') problems.push(`${skillFile}: metadata.${k} must be a string`);
  }
  if (map['allowed-tools'] !== undefined && typeof map['allowed-tools'] !== 'string')
    problems.push(`${skillFile}: allowed-tools must be a space-separated string`);

  const bodyLines = body.replace(/\s+$/, '').split('\n').length;
  if (bodyLines > SPEC_MAX_BODY)
    problems.push(`${skillFile}: body is ${bodyLines} lines; the spec's limit is ${SPEC_MAX_BODY}`);
  else if (bodyLines > MAX_BODY)
    problems.push(`${skillFile}: body is ${bodyLines} lines; the kit's budget is ${MAX_BODY}`);
  const tokens = Math.round(body.length / 4);
  if (tokens > 5000) problems.push(`${skillFile}: body is about ${tokens} tokens; the spec asks for under 5000`);
  else if (tokens > 3500) warnings.push(`${skillFile}: body is about ${tokens} tokens; the kit's budget is 3500`);

  const refDir = path.join(dir, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith('.md')) continue;
      const n = fs.readFileSync(path.join(refDir, f), 'utf8').replace(/\s+$/, '').split('\n').length;
      if (n > MAX_REFERENCE) problems.push(`${path.join(refDir, f)}: ${n} lines; the budget is ${MAX_REFERENCE}`);
    }
  }
  for (const ref of body.matchAll(/`references\/([a-z0-9-]+\.md)`/g)) {
    if (!fs.existsSync(path.join(refDir, ref[1])))
      problems.push(`${skillFile}: mentions references/${ref[1]}, which does not exist`);
  }
  return { problems, warnings, name, bodyLines, tokens };
}

function tryReference(dir) {
  if (builtinOnly) return 'skipped';
  const run = spawnSync('npx', ['-y', 'skills-ref', 'validate', dir], {
    encoding: 'utf8',
    timeout: 120_000,
    shell: process.platform === 'win32',
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status === 0 && /valid skill/i.test(out)) return 'valid';
  if (/validation failed/i.test(out)) return `invalid: ${out.trim().split('\n').slice(1).join('; ').trim()}`;
  return 'unavailable';
}

let failed = false;
for (const dir of skillDirs()) {
  const { problems, warnings, name, bodyLines, tokens } = validateSkill(dir);
  const reference = problems.length === 0 ? tryReference(dir) : 'skipped';
  const label = path.relative(root, dir).split(path.sep).join('/') || dir;
  if (problems.length > 0 || reference.startsWith('invalid')) {
    failed = true;
    console.error(`skill ${label}: INVALID`);
    for (const p of problems) console.error(`  - ${p}`);
    if (reference.startsWith('invalid')) console.error(`  - skills-ref: ${reference.slice(9)}`);
  } else {
    const ref =
      reference === 'valid'
        ? 'skills-ref agrees'
        : reference === 'skipped'
          ? 'built-in checks only'
          : 'skills-ref unavailable here, built-in checks only';
    console.log(`skill ${label} (${name}): valid, body ${bodyLines} lines, about ${tokens} tokens; ${ref}`);
  }
  for (const w of warnings) console.warn(`  warning: ${w}`);
}
process.exit(failed ? 1 : 0);
