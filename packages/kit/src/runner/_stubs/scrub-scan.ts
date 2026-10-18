// Stand-in for src/evidence/scrub.ts and scan.ts (Task 3): the pipeline by hand (`evidence scrub|scan`).
import type { ScanResult, ScrubResult } from '../../types.ts';

export async function scrub(_dir: string, _options: { values?: string[] } = {}): Promise<ScrubResult> {
  return { replaced: 0, secretValues: [], cookieValues: 0, problems: ['stand-in: the scrubber lands with Task 3'] };
}

export async function scan(_dir: string): Promise<ScanResult> {
  return { at: new Date().toISOString(), scannedFiles: 0, findings: 0, files: [], quarantined: [] };
}
