// Stand-in for src/evidence/post-run.ts (Task 3): reads and deletes the scrub-values file, writes scan.json,
// SUMMARY.md and the marker last, returns 0 or 1. Throws on an internal error (the runner treats that as 4).
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE, EXIT, type ExitCode, type ScanResult } from '../../types.ts';

export interface PostRunOptions {
  runDir: string;
  /** Playwright's exit code */
  suiteExitCode: number;
  /** the second run of `--twice`, for FLAKES.md */
  compareWith?: string;
  /** the NUL-separated 0600 file of values to scrub; read once and deleted */
  scrubValuesFile?: string;
}

function readValues(file: string | undefined): string[] {
  if (!file) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (file) fs.rmSync(file, { force: true });
  }
}

export async function postRun(options: PostRunOptions): Promise<ExitCode> {
  const values = readValues(options.scrubValuesFile);
  const dir = options.runDir;
  if (!fs.existsSync(dir)) throw new Error(`no run folder at ${dir}`);
  const resultsFile = path.join(dir, EVIDENCE.results);
  const ran = fs.existsSync(resultsFile);
  const scan: ScanResult = { at: new Date().toISOString(), scannedFiles: 0, findings: 0, files: [], quarantined: [] };
  fs.writeFileSync(path.join(dir, EVIDENCE.scan), `${JSON.stringify(scan, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, EVIDENCE.suite), `${JSON.stringify({ exitCode: options.suiteExitCode })}\n`);
  const runId = path.basename(dir);
  const code: ExitCode = options.suiteExitCode === 0 && ran ? EXIT.PASS : EXIT.FAIL;
  const lines = [
    `# Run ${runId}: ${code === EXIT.PASS ? 'PASS' : 'FAIL'}`,
    '',
    `- suite exit: ${options.suiteExitCode}${ran ? '' : ' (NO RESULTS)'}`,
    `- scan: clean (stand-in; ${values.length} value${values.length === 1 ? '' : 's'} registered)`,
    options.compareWith ? `- compared with: ${path.basename(options.compareWith)}` : '',
    '',
  ];
  fs.writeFileSync(path.join(dir, EVIDENCE.summary), lines.filter((l) => l !== undefined).join('\n'));
  fs.rmSync(path.join(dir, EVIDENCE.sensitiveHashes), { force: true });
  fs.writeFileSync(path.join(dir, EVIDENCE.marker), String(code));
  return code;
}
