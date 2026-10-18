// What a test is for, recorded where the coverage table (COVERAGE.md) and a reviewer read it.
import { test } from '@playwright/test';

/**
 * Record a test's source (the doc and case it comes from) and its expected result, as annotations.
 *
 *   about('workspaces spec §3, case 1', 'the removed member sees nothing of the workspace');
 */
export function about(source: string, expected: string): void {
  const info = test.info();
  info.annotations.push({ type: 'source', description: source }, { type: 'expected', description: expected });
}
