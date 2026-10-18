#!/usr/bin/env node
// The kit's CLI (plan §4.4): init, doctor, run, health, seed, report, evidence, check-tests, demo (mcp in v0.2).
//
// Task 0 stub. Task 4 implements runner/{cli,staging,lock,docker,doctor,global-setup,worker-shim,check-tests}.ts and
// makes `main` dispatch to them. The contract: `main(argv)` resolves to an exit code from `EXIT` and never throws
// for a usage error (it prints one line and returns `EXIT.USAGE`); no shell is spawned anywhere (`execFile` with
// argv arrays); a secret value is never in argv, in a log line or in a worker's environment.
import { pathToFileURL } from 'node:url';
import { CLI_NAME } from './brand.ts';
import { EXIT, type ExitCode } from './types.ts';

export type { CliCommand, DoctorOptions, ExitCode, RunMode, RunOptions } from './types.ts';
export { EXIT } from './types.ts';

export async function main(_argv: readonly string[] = process.argv.slice(2)): Promise<ExitCode> {
  throw new Error(`TODO Task 4: the ${CLI_NAME} CLI`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT.USAGE);
    });
}
