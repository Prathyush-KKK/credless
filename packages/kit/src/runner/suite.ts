// The two hidden entry points `run` starts as their own processes: `__suite` (inside the container, where the
// project's own Playwright and the shim are resolved from /work) and `__post-run` (natively and in the container).
import { pathToFileURL } from 'node:url';
import { CLI_NAME } from '../brand.ts';
import { ENV, EXIT, type ExitCode } from '../types.ts';
import { postRun } from './deps.ts';
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

/** `__post-run <dir> --suite-exit <n> [--compare <dir>]`: the pipeline; 0 or 1 with the marker, anything else is 4. */
export async function postRunEntry(args: string[], io: EntryIo): Promise<ExitCode | number> {
  const dir = args[0];
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const suiteExit = Number(at('--suite-exit'));
  if (!dir || dir.startsWith('--') || !Number.isInteger(suiteExit)) {
    io.stderr.write(`${CLI_NAME}: usage: __post-run <run dir> --suite-exit <code> [--compare <run dir>]\n`);
    return EXIT.USAGE;
  }
  try {
    const code = await postRun({
      runDir: dir,
      suiteExitCode: suiteExit,
      compareWith: at('--compare'),
      scrubValuesFile: io.env[ENV.SCRUB_VALUES_FILE],
    });
    return code;
  } catch (error) {
    io.stderr.write(`${CLI_NAME} post-run: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.EVIDENCE_UNSAFE;
  }
}
