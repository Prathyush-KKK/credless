// `<kit>/reporter` (plan §3): the kit's Playwright reporter: CTRF emit through the optional CTRF reporter and the
// `preprocess` hook that skips suites when health failed (v0.2).
//
// Task 0 stub. Task 3 owns the evidence formats; the reporter itself lands in v0.2.
import type { Reporter } from '@playwright/test/reporter';
import type { KitReporterOptions } from '../types.ts';

export type { KitReporterOptions } from '../types.ts';

export default class KitReporter implements Reporter {
  constructor(_options: KitReporterOptions = {}) {
    throw new Error('TODO Task 3 (v0.2): the kit reporter');
  }
}
