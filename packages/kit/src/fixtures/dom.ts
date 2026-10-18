// Small page helpers every test can use: wait for the app to boot, look for text (a secret is looked for but
// never printed), wait for an API call.
import { expect, type Locator, type Page } from '@playwright/test';
import type { SecretValue } from '../types.ts';

export type TextMatch = string | RegExp | SecretValue;

/** Is this a {@link SecretValue}? Duck-typed, so any adapter's wrapper counts. */
export function isSecretValue(value: unknown): value is SecretValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SecretValue).reveal === 'function' &&
    typeof (value as SecretValue).label === 'string'
  );
}

/** How a text is named in an assertion message: a secret by its label only. */
function label(text: TextMatch): string {
  return isSecretValue(text) ? `<${text.label}>` : String(text);
}

function plain(text: TextMatch): string | RegExp {
  return isSecretValue(text) ? text.reveal() : text;
}

/** Wait until the app has booted: the boot cover is gone (no cover configured: nothing to wait for). */
export async function ready(page: Page, bootCover?: string, timeout = 20_000): Promise<void> {
  if (!bootCover) return;
  await expect(page.locator(bootCover), 'the boot cover is gone').toHaveCount(0, { timeout });
}

/**
 * Visible somewhere in the page or the locator (substring for strings). A secret is looked for but never printed:
 * the failure says only its label.
 */
export async function see(scope: Page | Locator, text: TextMatch, timeout = 10_000): Promise<void> {
  const value = plain(text);
  const locator = typeof value === 'string' ? scope.getByText(value, { exact: false }) : scope.getByText(value);
  if (!isSecretValue(text)) {
    await expect(locator.first(), `"${label(text)}" is on screen`).toBeVisible({ timeout });
    return;
  }
  // a plain expect would quote the locator (and the value) in its failure: poll a boolean instead
  await expect
    .poll(
      () =>
        locator
          .first()
          .isVisible()
          .catch(() => false),
      { message: `"${label(text)}" is on screen`, timeout },
    )
    .toBe(true);
}

/** Nowhere in the page's text, including field values. Checks once: call it after the screen has settled. */
export async function notSee(scope: Page | Locator, text: TextMatch): Promise<void> {
  const value = plain(text);
  const root =
    'locator' in scope && typeof (scope as Page).goto === 'function'
      ? (scope as Page).locator('body')
      : (scope as Locator);
  const body = await root.innerText();
  const fields = await root
    .locator('input, textarea')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join('\n'));
  const all = `${body}\n${fields}`;
  const found = typeof value === 'string' ? all.includes(value) : value.test(all);
  expect(found, `"${label(text)}" is not on screen`).toBe(false);
}

/** Wait for the API call a screen makes (for example the search request) to answer. */
export async function waitForApi(page: Page, path: RegExp, timeout = 15_000): Promise<void> {
  await page.waitForResponse((r) => path.test(new URL(r.url()).pathname), { timeout });
}
