// Whether a module is the script Node was started with, so the CLI module runs `main()` when it is the program and
// stays inert when it is imported (the `credless/cli` export, the tests). npm installs the bin as a symlink
// (`node_modules/.bin/credless -> ../credless/dist/cli.js`) and Node keeps the link's path in `process.argv[1]` while
// `import.meta.url` names the real file, so the two are compared as real paths. A path that cannot be resolved falls
// back to its plain absolute form: this runs at import time and must never throw.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** True when `moduleUrl` (an `import.meta.url`) is the file `argv1` names, directly or through symlinks. */
export function isEntryScript(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const a = realPath(argv1);
  const b = realPath(modulePath);
  // Windows paths are case-insensitive, and a drive letter may come back in either case.
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
