// npm, npx and pnpm as argv arrays for spawn, for the release scripts (smoke-pack.mjs, release.mjs). Started as Node
// scripts where they can be found, so no shell and no Windows .cmd shim is ever involved: npm's CLI beside this Node
// (its two install layouts), pnpm's from `npm_execpath` when a pnpm script started us; else the bare name on PATH.
import fs from 'node:fs';
import path from 'node:path';

/** `[command, ...leading args]` for `npm`, `npx` or `pnpm`. */
export function packageManager(name) {
  if (name === 'pnpm' && /pnpm\.c?js$/.test(process.env.npm_execpath ?? '')) {
    return [process.execPath, process.env.npm_execpath];
  }
  if (name === 'npm' || name === 'npx') {
    const bin = path.dirname(process.execPath);
    for (const dir of [path.join(bin, 'node_modules'), path.join(bin, '..', 'lib', 'node_modules')]) {
      const script = path.join(dir, 'npm', 'bin', `${name}-cli.js`);
      if (fs.existsSync(script)) return [process.execPath, script];
    }
  }
  return [name];
}
