// The scan: what is still secret-shaped in a run folder, by file and kind, never by value. Read-only on its own;
// `quarantineDir` is the post-run form that deletes the files a finding survived in, lists them in QUARANTINED.md
// and writes scan.json.
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE, EXIT, type ExitCode, type ScanFinding, type ScanResult, type ScrubResult } from '../types.ts';
import { findInText, prepareValues, revealAll, type SecretLike, type ShapeOptions, shapesForRun } from './patterns.ts';
import { fileOf, topFile, visitTexts } from './walk.ts';

export interface ScanOptions extends ShapeOptions {
  /** the run's registered secret values: a hit is the `secret-value` kind, and fails the run */
  values?: Iterable<SecretLike>;
  /** values the scrub collected (cookies, credential headers): a hit is the `cookie-value` kind */
  cookieValues?: Iterable<string>;
}

/** The scan's result plus what could not be looked into. */
export interface ScanOutcome extends ScanResult {
  problems: string[];
}

/** What scan.json holds: the scan, what the quarantine removed, and what the scrub counted. */
export interface ScanFile extends ScanResult {
  /** findings of the second scan, after the quarantine; anything here makes the evidence unsafe to keep */
  leftAfterRemoval: ScanFinding[];
  /** registered secret values the scrub found and redacted (any number above 0 fails the run) */
  secretValues: number;
  /** the files they were in (top-level paths, never values) */
  secretValuesIn: string[];
}

export interface QuarantineOptions extends ScanOptions {
  /** the scrub that ran before, for the leak count in scan.json */
  scrubbed?: ScrubResult;
}

export interface QuarantineOutcome {
  scan: ScanFile;
  /** a finding survived even the removal: the folder must not be kept */
  unsafe: boolean;
  problems: string[];
}

/** Scan a run folder read-only. Each finding names the file (and the path inside a zip) and the kind, never a value. */
export function scanDir(dir: string, options: ScanOptions = {}): ScanOutcome {
  const shapes = shapesForRun(dir, options);
  const values = prepareValues(revealAll(options.values));
  const cookies = prepareValues(options.cookieValues ?? []);
  const files: ScanFinding[] = [];
  const visited = visitTexts(
    dir,
    (text, where) => {
      for (const [kind, count] of Object.entries(findInText(text, shapes, values, cookies))) {
        files.push({ file: where, kind, count });
      }
      return null;
    },
    { write: false },
  );
  return {
    at: new Date().toISOString(),
    scannedFiles: visited.files,
    findings: files.length,
    files,
    quarantined: [],
    problems: visited.problems,
  };
}

/**
 * The exit code a stand-alone scan ends with: 0 clean; 1 when only registered values were found (a code path leaks
 * them; the scrub removes them); 4 when something secret-shaped is there that only deletion can handle.
 */
export function scanExitCode(result: ScanResult): ExitCode {
  if (result.files.length === 0) return EXIT.PASS;
  return result.files.every((f) => f.kind === 'secret-value') ? EXIT.FAIL : EXIT.EVIDENCE_UNSAFE;
}

/**
 * Post-run's scan: anything the scrub could not clean is not kept. The file a finding lives in is deleted and listed
 * in QUARANTINED.md, the folder is scanned again, the fixtures' HMAC list is removed, and scan.json is written. A
 * finding that survives the removal makes the folder unsafe.
 */
export function quarantineDir(dir: string, options: QuarantineOptions = {}): QuarantineOutcome {
  const first = scanDir(dir, options);
  const problems = [...first.problems];
  const removed: string[] = [];
  const removedFiles = new Set<string>();
  let again = first;
  if (first.files.length > 0) {
    // Every kind found in a file is listed with it, so the quarantine note says what the file still held.
    const kindsByFile = new Map<string, Set<string>>();
    for (const finding of first.files) {
      const top = topFile(finding.file);
      kindsByFile.set(top, (kindsByFile.get(top) ?? new Set<string>()).add(finding.kind));
    }
    for (const [top, kinds] of kindsByFile) {
      const file = fileOf(dir, top);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removedFiles.add(top);
        removed.push(`${top} (${[...kinds].sort().join(', ')})`);
      }
    }
    fs.writeFileSync(
      path.join(dir, EVIDENCE.quarantined),
      `# Evidence removed by the secret scan\n\nThese files still held something secret-shaped after scrubbing and were deleted (values never shown):\n\n${removed.map((r) => `- ${r}`).join('\n')}\n`,
    );
    again = scanDir(dir, options);
    problems.push(...again.problems);
  }
  fs.rmSync(path.join(dir, EVIDENCE.sensitiveHashes), { force: true });
  const scrubbed = options.scrubbed;
  const scan: ScanFile = {
    at: first.at,
    scannedFiles: first.scannedFiles,
    findings: first.findings,
    files: first.files,
    quarantined: [...removedFiles],
    leftAfterRemoval: again.files,
    secretValues: (scrubbed?.secretValues ?? []).reduce((n, v) => n + v.count, 0),
    secretValuesIn: [...new Set((scrubbed?.secretValues ?? []).map((v) => topFile(v.where)))],
  };
  fs.writeFileSync(path.join(dir, EVIDENCE.scan), `${JSON.stringify(scan, null, 2)}\n`);
  return { scan, unsafe: again.files.length > 0, problems };
}
