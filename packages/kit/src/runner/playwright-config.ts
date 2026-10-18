// What every Playwright config of a kit project spells the same way (plan §8): the reporters into this run's
// evidence folder, the global setup that takes the key over and starts the broker, the trace and worker knobs from
// the environment the CLI sets, and no retries. The kit's own config and the demo's spread the result; a consumer's
// can too. Playwright evaluates a config in its main process and again in every worker, so everything here is
// deterministic for one run id and writes nothing but two environment variables.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig, ReporterDescription } from '@playwright/test';
import { KIT_NAME } from '../brand.ts';
import { pinRunId } from '../config/load.ts';
import { DEFAULTS, ENV, EVIDENCE, type TraceMode } from '../types.ts';

export interface KitPlaywrightOptions {
  /** the project directory, where `<kit>.config.ts` lives; a run not started by the CLI keeps its evidence under it */
  rootDir: string;
  /** where kept evidence goes, relative to `rootDir` (`evidence.reportsDir`); default {@link DEFAULTS.reportsDir} */
  reportsDir?: string;
  /** the target a run not started by the CLI points at (`ENV.TARGET` wins when set) */
  target?: string;
  /** the trace mode when `ENV.TRACE` is unset (`evidence.trace`); default {@link DEFAULTS.trace} */
  trace?: TraceMode;
}

export interface KitPlaywrightConfig {
  /** this run's id, pinned in the environment so every worker agrees */
  runId: string;
  /** this run's evidence folder: `ENV.REPORT_DIR`, or `<reportsDir>/<run id>` under the project for a bare run */
  reportDir: string;
  /** the part of the Playwright config the kit decides; spread it, then add `testDir` and `projects` */
  config: Pick<
    PlaywrightTestConfig,
    'reporter' | 'outputDir' | 'globalSetup' | 'retries' | 'forbidOnly' | 'fullyParallel' | 'workers' | 'use'
  >;
}

const TRACE_MODES: readonly string[] = ['off', 'retain-on-failure', 'on'];

/** The kit's global setup beside this module: `global-setup.ts` in the source tree, `global-setup.js` in the bundle. */
export function globalSetupPath(): string {
  for (const name of ['global-setup.ts', 'global-setup.js']) {
    const file = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`${KIT_NAME}: global-setup not found beside ${fileURLToPath(import.meta.url)}`);
}

/** The optional CTRF reporter, by its resolved path (a name would be resolved from the config's directory). */
function ctrfReporter(reportDir: string): ReporterDescription | null {
  try {
    const file = createRequire(import.meta.url).resolve('playwright-ctrf-json-reporter');
    return [file, { outputDir: reportDir, outputFile: EVIDENCE.ctrf }];
  } catch {
    return null;
  }
}

/** The run id, the evidence folder and the Playwright options the kit decides for every project. */
export function kitPlaywrightConfig(options: KitPlaywrightOptions): KitPlaywrightConfig {
  const env = process.env;
  if (options.target) env[ENV.TARGET] ??= options.target;
  const runId = pinRunId(env);
  const reportDir = path.resolve(
    env[ENV.REPORT_DIR] || path.join(options.rootDir, options.reportsDir ?? DEFAULTS.reportsDir, runId),
  );
  // Pinned for the workers too: the fixtures put screenshots and aria snapshots where the reporters write.
  env[ENV.REPORT_DIR] = reportDir;
  const wanted = env[ENV.TRACE];
  const trace: TraceMode =
    wanted && TRACE_MODES.includes(wanted) ? (wanted as TraceMode) : (options.trace ?? DEFAULTS.trace);
  const workers = env[ENV.WORKERS] ? Number(env[ENV.WORKERS]) : undefined;
  const reporter: ReporterDescription[] = [
    ['list'],
    ['html', { outputFolder: path.join(reportDir, EVIDENCE.html), open: 'never', noSnippets: true }],
    ['json', { outputFile: path.join(reportDir, EVIDENCE.results) }],
    ['junit', { outputFile: path.join(reportDir, EVIDENCE.junit) }],
    ['blob', { outputDir: path.join(reportDir, path.dirname(EVIDENCE.blob)), fileName: path.basename(EVIDENCE.blob) }],
  ];
  const ctrf = ctrfReporter(reportDir);
  if (ctrf) reporter.push(ctrf);
  return {
    runId,
    reportDir,
    config: {
      reporter,
      outputDir: path.join(reportDir, EVIDENCE.artifacts),
      globalSetup: globalSetupPath(),
      // No hidden retries: flakiness is reported by `run --twice`, never retried into green.
      retries: 0,
      forbidOnly: true,
      fullyParallel: true,
      ...(workers && Number.isInteger(workers) && workers > 0 ? { workers } : {}),
      // The kit takes its own screenshots (masked); Playwright's would carry what the masks hide.
      use: { trace, video: 'off', screenshot: 'off' },
    },
  };
}
