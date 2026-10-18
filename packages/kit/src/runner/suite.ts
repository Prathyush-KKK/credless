// The two hidden entry points `run` starts as their own processes: `__suite` (inside the container, where the
// project's own Playwright and the shim are resolved from /work) and `__post-run` (natively and in the container).
import { pathToFileURL } from 'node:url';
import { CLI_NAME } from '../brand.ts';
import { EXIT, type ExitCode } from '../types.ts';
import { postRunMain } from './deps.ts';
import { resolvePlaywrightCli, shimPath, spawnRedacted } from './spawn.ts';

export interface EntryIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** `__suite <playwright args>`: run `playwright test` here with the shim; the environment is already the allowlist. */
export async function suite(args: string[], io: EntryIo): Promise<number> {
  const pwCli = resolvePlaywrightCli(io.cwd);
  if (!pwCli) {
    io.stderr.write(`${CLI_NAME}: Playwright's CLI is not resolvable from ${io.cwd}\n`);
    return EXIT.USAGE;
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
  const shim = shimPath();
  if (shim) env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(' ');
  const result = await spawnRedacted(process.execPath, [pwCli, 'test', ...args], {
    cwd: io.cwd,
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return result.code ?? 128;
}

/**
 * `__post-run <dir> --suite-exit <n> [--compare <dir>] [--cookie-names a,b] [--header-names a,b] [--code-shape s]`:
 * the evidence pipeline (evidence/post-run.ts), which reads the scrub-values file and the evidence key from the
 * environment and removes the file's name from it at once. 0 or 1 come with the marker; anything else is 4 and the
 * caller deletes the folder. Nothing thrown here is repeated: it could quote what post-run choked on.
 */
export async function postRunEntry(args: string[], io: EntryIo): Promise<ExitCode> {
  try {
    return await postRunMain(args, io.env);
  } catch (error) {
    io.stderr.write(`${CLI_NAME} post-run: failed (${error instanceof Error ? error.name : 'error'})\n`);
    return EXIT.EVIDENCE_UNSAFE;
  }
}
