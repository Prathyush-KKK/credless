// The demo app as Playwright's `webServer`, for a config that runs the kit's self-tests or the quickstart suite
// without `credless demo` starting the app: the server on ephemeral ports, its ready line read by the wait regex
// (the named groups land in the environment as DEMO_WEB and DEMO_API, docs/conventions.md §10), and the stand-in
// runner key the server writes to a fresh 0600 file (`--write-key`) that the config's `file` key source reads
// through CREDLESS_DEMO_KEY_FILE. The default export is the matching `globalTeardown`: it removes that file. Nothing
// here is a secret: the key is random per run and worthless once the demo stops. Lives with the test helpers because
// a Playwright config may do what a test file may not (read the environment, name a file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV } from '../../src/types.ts';

/** The one line the server prints once everything listens (apps/demo/src/server.ts). */
export const READY = /ready web=(?<DEMO_WEB>\S+) api=(?<DEMO_API>\S+)/;

export interface DemoWebServerOptions {
  /** this run's id: the key file is named after it, so two runs never share one */
  runId: string;
  /** the demo's server script (apps/demo/src/server.ts) */
  server: string;
}

/** Playwright's `webServer` entry for the demo (the subset of its options the demo needs). */
export interface DemoWebServer {
  command: string;
  wait: { stdout: RegExp };
  timeout: number;
  reuseExistingServer: false;
  stdout: 'ignore';
  stderr: 'pipe';
}

/** The command runs through a shell: paths are quoted, so a directory with a space in its name works. */
const quote = (value: string): string => `"${value}"`;

/**
 * Start the demo for this run. Playwright evaluates the config in its main process (which starts the server) and in
 * every worker (which must not touch the file), so only the main process removes a stale file first.
 */
export function demoWebServer(options: DemoWebServerOptions): DemoWebServer {
  const keyFile = path.join(os.tmpdir(), `credless-demo-${options.runId}.key`);
  if (!process.env.TEST_WORKER_INDEX) fs.rmSync(keyFile, { force: true });
  process.env[ENV.DEMO_KEY_FILE] = keyFile;
  return {
    // the server inherits this process's environment, which now names the key file; `--write-key` wins there
    command: `${quote(process.execPath)} ${quote(options.server)} --write-key ${quote(keyFile)}`,
    wait: { stdout: READY },
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  };
}

/** Playwright's `globalTeardown`: the key file the server wrote goes with the run (Playwright kills the server). */
export default async function removeDemoKeyFile(): Promise<void> {
  const file = process.env[ENV.DEMO_KEY_FILE];
  if (file) fs.rmSync(file, { force: true });
}
