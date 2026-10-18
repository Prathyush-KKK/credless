// Evidence a person can check in a minute: a screenshot of each screen a test checked, taken inside the test right
// after its checks (never at teardown, never of the boot cover), named after the case, the persona and the step,
// with one-time codes and password fields masked. Also the helpers that put a secret into a field without it
// appearing anywhere, and the aria snapshot an agent can read instead of a picture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  DEFAULTS,
  ENV,
  EVIDENCE,
  type SecretValue,
  type SensitiveText as SensitiveTextShape,
  type ShotOptions,
} from '../types.ts';

/** How long a shot waits for the boot cover to go. */
export const BOOT_COVER_TIMEOUT_MS = 15_000;

/** What the masks and the aria writer need from the config. */
export interface EvidenceSettings {
  /** this run's evidence directory; shots go to `<reportDir>/shots`, aria snapshots to `<reportDir>/aria` */
  reportDir?: string;
  /** the app's boot cover: a shot waits until it is gone */
  bootCover?: string;
  /** selectors masked in every shot, in addition to {@link DEFAULTS.alwaysMasked} */
  maskSelectors?: string[];
  /** `digits6` (default) or a regular expression source for what counts as a one-time code */
  codeShape?: string;
  /** keys the HMAC list of codes the scrubber removes (`ENV.EVIDENCE_KEY`) */
  evidenceKey?: string;
}

/** The slug of a title, a persona id or a step, for a file name. */
export function slug(text: string, max = 80): string {
  return text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
}

/** This run's evidence directory as the fixtures see it (the runner sets it; a bare Playwright run gets test-results). */
export function reportDirFor(testInfo: TestInfo): string {
  return path.resolve(process.env[ENV.REPORT_DIR] ?? path.join(testInfo.config.rootDir, 'test-results'));
}

function caseName(testInfo: TestInfo): string {
  return slug(testInfo.titlePath[testInfo.titlePath.length - 1] ?? 'test');
}

/** `shots/<case>--<persona>-<step>-<project>.png`; `FAILED` is the step of a triage shot. */
export function shotPath(testInfo: TestInfo, who: string, step = 'screen', project = testInfo.project.name): string {
  const name = `${caseName(testInfo)}--${slug(who, 24)}-${slug(step, 40)}-${slug(project)}.png`;
  return path.join(reportDirFor(testInfo), EVIDENCE.shots, name);
}

/** `aria/<case>--<persona>-<step>.yaml`. */
export function ariaPath(testInfo: TestInfo, who: string, step = 'screen'): string {
  return path.join(
    reportDirFor(testInfo),
    EVIDENCE.aria,
    `${caseName(testInfo)}--${slug(who, 24)}-${slug(step, 40)}.yaml`,
  );
}

/** The ways a six-digit code shows on screen: 418203, 418 203, 418-203. Another shape is masked as typed. */
export function codeForms(code: string, codeShape: string = DEFAULTS.codeShape): string[] {
  if (codeShape === 'digits6' && /^\d{6}$/.test(code))
    return [code, `${code.slice(0, 3)} ${code.slice(3)}`, `${code.slice(0, 3)}-${code.slice(3)}`];
  return [code];
}

/** HMAC of a code under the run's evidence key: the scrubber matches by hash, so the list never holds a code. */
export function hashSensitive(value: string, key: string): string {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

/**
 * Codes in play in one test (from the control API, from mail): masked in every shot and, as HMACs under the run's
 * evidence key, appended to `.sensitive-hashes` in the run's private staging folder for the scrubber, which deletes
 * the list before the evidence is kept.
 */
export class SensitiveText implements SensitiveTextShape {
  readonly #codes = new Set<string>();
  readonly #settings: EvidenceSettings;

  constructor(settings: EvidenceSettings = {}) {
    this.#settings = settings;
  }

  add(secret: SecretValue | null | undefined): void {
    if (!secret) return;
    const value = secret.reveal();
    for (const form of codeForms(value, this.#settings.codeShape)) this.#codes.add(form);
    const { reportDir, evidenceKey } = this.#settings;
    if (!reportDir || !evidenceKey) return;
    try {
      fs.mkdirSync(reportDir, { recursive: true });
      fs.appendFileSync(path.join(reportDir, EVIDENCE.sensitiveHashes), `${hashSensitive(value, evidenceKey)}\n`, {
        mode: 0o600,
      });
    } catch {
      // the scrubber's generic patterns still apply; masking in screenshots does not depend on this file
    }
  }

  locators(page: Page): Locator[] {
    return [...this.#codes].map((text) => page.getByText(text, { exact: false }));
  }

  get plain(): string[] {
    return [...this.#codes].filter((c) => /^\d+$/.test(c));
  }

  get size(): number {
    return this.#codes.size;
  }
}

/** Wait for the boot cover to be gone, then save the screenshot with codes and passwords masked. Returns its path. */
export async function takeShot(
  page: Page,
  file: string,
  sensitive: SensitiveTextShape,
  options: ShotOptions = {},
  settings: Pick<EvidenceSettings, 'bootCover' | 'maskSelectors'> = {},
): Promise<string> {
  if (!options.triage && settings.bootCover) {
    await expect(page.locator(settings.bootCover), 'the boot cover is gone before the screenshot').toHaveCount(0, {
      timeout: BOOT_COVER_TIMEOUT_MS,
    });
  }
  if (sensitive.size) {
    // A typed code lives in an input's value, which text locators do not see: mark those fields for the mask.
    await page.evaluate((codes) => {
      for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
        const value = ((el as HTMLInputElement).value ?? '').replace(/[\s-]/g, '');
        if (codes.some((code) => value.includes(code))) el.setAttribute('data-sensitive', '');
      }
    }, sensitive.plain);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({
    path: file,
    fullPage: options.fullPage ?? false,
    mask: [
      page.locator(DEFAULTS.alwaysMasked),
      ...(settings.maskSelectors ?? []).map((selector) => page.locator(selector)),
      ...sensitive.locators(page),
      ...(options.mask ?? []),
    ],
    maskColor: DEFAULTS.maskColor,
    animations: 'disabled',
  });
  return file;
}

/** Write the page's aria snapshot as agent-readable, scrubbable text. Returns the path. */
export async function writeAria(page: Page, file: string): Promise<string> {
  const snapshot = await page.ariaSnapshot();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${snapshot.trimEnd()}\n`, { mode: 0o600 });
  return file;
}

/**
 * Put a secret into a field without it appearing anywhere: not in a step title (Playwright titles fill() with its
 * value, and the HTML report keeps step titles), not in a log. The value is set through the native setter and an
 * input event, which framework-controlled fields accept as typing.
 */
export async function typeSecret(field: Locator, secret: SecretValue): Promise<void> {
  await field.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, secret.reveal());
}

/** Empty a field that held a secret, so no later snapshot of the page can show it. */
export async function clearSecretField(field: Locator): Promise<void> {
  await field
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })
    .catch(() => undefined);
}

/**
 * The colour of one pixel of a saved shot, decoded in the page (x and y in CSS pixels of a page with this device
 * pixel ratio). The self-tests prove a mask with it; test code reads no files itself.
 */
export async function shotPixel(page: Page, file: string, x: number, y: number, dpr = 1): Promise<number[]> {
  const png = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  return page.evaluate(
    async ({ png, x, y }) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d canvas');
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    },
    { png, x: Math.round(x * dpr), y: Math.round(y * dpr) },
  );
}

/** Does a saved piece of evidence exist? (For the self-tests, which may not touch the file system.) */
export function evidenceExists(file: string): boolean {
  return fs.existsSync(file);
}
