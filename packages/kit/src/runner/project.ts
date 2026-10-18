// Where a project is: the directory that holds `<kit>.config.*`. The CLI needs it before the config loader runs,
// because the reports dir, the Playwright config and the staging override are all relative to it, and because the
// config loader itself is told which file to read.
import fs from 'node:fs';
import path from 'node:path';
import { KIT_NAME } from '../brand.ts';

/** The config file names the CLI looks for, in order. */
export const CONFIG_FILE_NAMES: readonly string[] = ['ts', 'mts', 'js', 'mjs'].map(
  (ext) => `${KIT_NAME}.config.${ext}`,
);

export interface Project {
  /** the directory of the config file: reports, the catalog and the Playwright config are relative to it */
  root: string;
  configFile: string;
}

/** Walk up from `cwd` to the first directory holding a config file; null when there is none. */
export function findConfigFile(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project for an explicit `--config` path or the nearest config file above `cwd`. Throws when there is none. */
export function findProject(cwd: string, explicit?: string): Project {
  if (explicit) {
    const configFile = path.resolve(cwd, explicit);
    if (!fs.existsSync(configFile)) throw new Error(`no config file at ${configFile}`);
    return { root: path.dirname(configFile), configFile };
  }
  const configFile = findConfigFile(cwd);
  if (!configFile) {
    throw new Error(
      `no ${CONFIG_FILE_NAMES[0]} in ${path.resolve(cwd)} or above it (run \`${KIT_NAME} init\`, or pass --config)`,
    );
  }
  return { root: path.dirname(configFile), configFile };
}
