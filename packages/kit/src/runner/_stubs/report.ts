// Stand-in for src/evidence/report.ts (Task 3): print a run's SUMMARY.md and compare two runs by results.json.
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE, type FlakeReport } from '../../types.ts';

export function summary(runDir: string): string {
  return fs.readFileSync(path.join(runDir, EVIDENCE.summary), 'utf8');
}

interface ResultsJson {
  suites?: Array<{
    specs?: Array<{ title: string; tests?: Array<{ status: string }> }>;
    suites?: ResultsJson['suites'];
  }>;
}

function outcomes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: ResultsJson;
  try {
    json = JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE.results), 'utf8')) as ResultsJson;
  } catch {
    return out;
  }
  const walk = (suites: ResultsJson['suites']) => {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) out.set(spec.title, spec.tests?.[0]?.status ?? 'unknown');
      walk(s.suites);
    }
  };
  walk(json.suites);
  return out;
}

export function compare(first: string, second: string): FlakeReport {
  const a = outcomes(first);
  const b = outcomes(second);
  const report: FlakeReport = {
    compared: [path.basename(first), path.basename(second)],
    flaky: [],
    onlyFirst: [],
    onlySecond: [],
  };
  for (const [title, status] of a) {
    if (!b.has(title)) report.onlyFirst.push(title);
    else if (b.get(title) !== status) report.flaky.push(title);
  }
  for (const title of b.keys()) if (!a.has(title)) report.onlySecond.push(title);
  return report;
}
