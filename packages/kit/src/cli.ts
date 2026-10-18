#!/usr/bin/env node
// The kit's CLI (plan §4.4): init, doctor, run, health, seed, report, evidence, check-tests, demo (mcp in v0.2).
//
// The contract: `main(argv)` resolves to an exit code from `EXIT` and never throws for a usage error (it prints one
// line and returns `EXIT.USAGE`); no shell is spawned anywhere (`execFile`/`spawn` with argv arrays); a secret value
// is never in argv, in a log line or in a worker's environment. The commands live in runner/.
import { pathToFileURL } from 'node:url';
import { CLI_NAME } from './brand.ts';
import { main } from './runner/cli.ts';
import { EXIT } from './types.ts';

export { main, parseArgs, USAGE } from './runner/cli.ts';
export type { CliCommand, DoctorOptions, ExitCode, RunMode, RunOptions } from './types.ts';
export { EXIT } from './types.ts';

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT.USAGE);
    });
}
