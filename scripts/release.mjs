#!/usr/bin/env node
// `pnpm release [--yes]`: publish the kit to npm from this machine. No CI runs for this repository and there is no
// OIDC token, so there is no provenance either: the gate is `pnpm verify` (check, self-tests, the demo, the build and
// the packed package installed into a blank project), run here, right before the publish. In order:
//  1. refuse unless on main with a clean tree and HEAD equal to origin/main (fetched first): what is published is
//     exactly what is pushed;
//  2. refuse when the version is tagged here already or is on npm already; with --yes, refuse when npm has no login;
//  3. pnpm verify;
//  4. show the version and the files npm would publish (`npm pack --dry-run`);
//  5. with --yes, `npm publish --access public` in packages/kit (npm asks for a one-time password itself when the
//     account has one); without it, print that command and stop;
//  6. after a publish, an annotated tag v<version>, and the `git push origin v<version>` to run; never pushed here.
//
//   node scripts/release.mjs [--yes]
//
// No shell anywhere (argv arrays). Exit 2 for a refusal, 1 for a failed step, 0 otherwise.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageManager } from './package-managers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = path.join(ROOT, 'packages', 'kit');
const PUBLISH = ['publish', '--access', 'public'];

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`release: unknown option ${unknown[0]} (only --yes)`);
  process.exit(2);
}
const yes = argv.includes('--yes');

function refuse(message) {
  console.error(`release: refused: ${message}`);
  process.exit(2);
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\nrelease: ${title}`);
}

/** Captured output, for the checks. */
function capture(command, args, cwd = ROOT) {
  const [cmd, ...pre] = Array.isArray(command) ? command : [command];
  const r = spawnSync(cmd, [...pre, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** The person sees the output (and answers npm's prompts); the exit code comes back. */
function interactive(command, args, cwd = ROOT) {
  const [cmd, ...pre] = Array.isArray(command) ? command : [command];
  return spawnSync(cmd, [...pre, ...args], { cwd, stdio: 'inherit', windowsHide: true }).status;
}

const git = (args) => capture('git', args);
const npm = packageManager('npm');

// 1. what is published is what is pushed
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
if (branch !== 'main') refuse(`on branch ${branch || '(none)'}; releases are cut from main`);
const dirty = git(['status', '--porcelain']).stdout;
if (dirty) refuse(`the working tree has changes; commit or stash them first:\n${dirty}`);
const fetched = git(['fetch', '--quiet', 'origin', 'main']);
if (fetched.status !== 0) refuse(`git fetch origin main failed: ${fetched.stderr}`);
const head = git(['rev-parse', 'HEAD']).stdout;
const upstream = git(['rev-parse', 'origin/main']).stdout;
if (head !== upstream) {
  const [behind = '?', ahead = '?'] = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']).stdout.split(
    /\s+/,
  );
  refuse(`main is ${ahead} commit(s) ahead of origin/main and ${behind} behind; push or pull first`);
}

// 2. a version is released once
const { name, version } = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'));
const tag = `v${version}`;
if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
  refuse(`tag ${tag} exists already; bump "version" in packages/kit/package.json`);
}
const onNpm = capture(npm, ['view', `${name}@${version}`, 'version'], KIT);
if (onNpm.status === 0 && onNpm.stdout === version) refuse(`${name}@${version} is on npm already; bump the version`);
if (onNpm.status !== 0 && !/E404|404 Not Found/.test(onNpm.stderr)) {
  refuse(`cannot ask the npm registry whether ${name}@${version} exists:\n${onNpm.stderr}`);
}
if (yes) {
  const who = capture(npm, ['whoami'], KIT);
  if (who.status !== 0) refuse('npm has no login on this machine: run `npm login` first');
  console.log(`release: publishing as npm user ${who.stdout}`);
}

// 3. the gate
step('pnpm verify: check, self-tests, the demo, the build, the packed package in a blank project');
if (interactive(packageManager('pnpm'), ['verify']) !== 0) fail('pnpm verify failed; nothing was published');
const changed = git(['status', '--porcelain']).stdout;
if (changed) fail(`pnpm verify changed tracked files; nothing was published:\n${changed}`);

// 4. what would go out
step(`${name}@${version}: the files npm publishes`);
if (interactive(npm, ['pack', '--dry-run'], KIT) !== 0) fail('npm pack --dry-run failed; nothing was published');

// 5. the publish, only when asked for
if (!yes) {
  console.log(
    `\nrelease: dry run, nothing published. \`pnpm release --yes\` runs, in packages/kit:\n  npm ${PUBLISH.join(' ')}\nand then tags ${tag} here. Run \`pnpm smoke:registry\` first if you have not (npm, pnpm, yarn, bun, -g, npx and\ndlx installs from a local registry; it needs the network, so verify does not run it).`,
  );
  process.exit(0);
}
step(`npm ${PUBLISH.join(' ')} (packages/kit)`);
if (interactive(npm, PUBLISH, KIT) !== 0) fail('npm publish failed; nothing was tagged');

// 6. the tag, pushed by the person
const tagged = git(['tag', '-a', tag, '-m', `${name} ${version}`]);
if (tagged.status !== 0) fail(`published ${name}@${version}, but tagging failed: ${tagged.stderr}`);
console.log(`\nrelease: published ${name}@${version} and tagged ${tag}. Push the tag:\n  git push origin ${tag}`);
