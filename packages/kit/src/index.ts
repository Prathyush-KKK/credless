// The kit's main entry (plan §3, src/index.ts): `test`, `expect`, `about`, `typeSecret`, `clearSecretField`,
// `see`/`notSee`, `Secret` and the shared types.
//
// Task 0 stub. Task 1 adds `Secret` (core/secret.ts); Task 2 replaces the throwing `test` and the helper stubs with
// `export { test, expect } from './fixtures/index.ts'`, `about` from fixtures/about.ts and the evidence helpers
// from fixtures/evidence.ts. The signatures below are the frozen ones.
import type { Locator, TestType } from '@playwright/test';
import type { KitTestFixtures, KitWorkerFixtures, SecretValue } from './types.ts';

export { expect } from '@playwright/test';
export { CANARY_HOST, CLI_NAME, ENV_PREFIX, KIT_NAME } from './brand.ts';
export * from './types.ts';

function todo<T extends object>(task: number, name: string): T {
  const fail = (): never => {
    throw new Error(`TODO Task ${task}: ${name} is not implemented yet`);
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail }) as unknown as T;
}

/** The kit's `test`: Playwright's test with the `personas`, `control`, `guard`, `shot` and `sensitive` fixtures. */
export const test: TestType<KitTestFixtures, KitWorkerFixtures> = todo(2, 'test');

/** Record a test's source (doc and case) and its expected result as annotations, for COVERAGE.md. */
export function about(_source: string, _expected: string): void {
  throw new Error('TODO Task 2: about()');
}

/** Put a secret into a field without it appearing in a step title, a log or a trace action. */
export async function typeSecret(_field: Locator, _secret: SecretValue): Promise<void> {
  throw new Error('TODO Task 2: typeSecret()');
}

/** Empty a field that held a secret, so no later snapshot of the page can show it. */
export async function clearSecretField(_field: Locator): Promise<void> {
  throw new Error('TODO Task 2: clearSecretField()');
}

/** Expect text on the page; a SecretValue is matched by its revealed value and never printed in the failure. */
export async function see(_locator: Locator, _text: string | RegExp | SecretValue): Promise<void> {
  throw new Error('TODO Task 2: see()');
}

/** Expect text to be absent from the page; SecretValue-aware like {@link see}. */
export async function notSee(_locator: Locator, _text: string | RegExp | SecretValue): Promise<void> {
  throw new Error('TODO Task 2: notSee()');
}
