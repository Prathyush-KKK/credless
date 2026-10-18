// One persona's browser: its own context (cookies, storage, guard, egress proxy), signed in through the session
// provider, with the evidence it leaves. No app screens live here: those are the app's own page objects.
import { AxeBuilder } from '@axe-core/playwright';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type {
  A11yFinding,
  AppSignals,
  Persona,
  PersonaApiOptions,
  PersonaApiResponse,
  PersonaSession as PersonaSessionShape,
  SensitiveText,
  ShotOptions,
} from '../types.ts';
import { ariaPath, type EvidenceSettings, shotPath, takeShot, writeAria } from './evidence.ts';
import type { AttachedGuard } from './guard.ts';

export interface PersonaSessionOptions {
  persona: Persona;
  context: BrowserContext;
  page: Page;
  guard: AttachedGuard;
  testInfo: TestInfo;
  sensitive: SensitiveText;
  apiOrigin: string;
  signals: AppSignals;
  evidence: Pick<EvidenceSettings, 'bootCover' | 'maskSelectors'>;
}

export class PersonaSession implements PersonaSessionShape {
  readonly persona: Persona;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guard: AttachedGuard;
  readonly shots: string[] = [];
  readonly a11yFindings: Array<{ step: string; findings: A11yFinding[] }> = [];
  readonly #testInfo: TestInfo;
  readonly #sensitive: SensitiveText;
  readonly #apiOrigin: string;
  readonly #signals: AppSignals;
  readonly #evidence: Pick<EvidenceSettings, 'bootCover' | 'maskSelectors'>;

  constructor(options: PersonaSessionOptions) {
    this.persona = options.persona;
    this.context = options.context;
    this.page = options.page;
    this.guard = options.guard;
    this.#testInfo = options.testInfo;
    this.#sensitive = options.sensitive;
    this.#apiOrigin = new URL(options.apiOrigin).origin;
    this.#signals = options.signals;
    this.#evidence = options.evidence;
  }

  /** persona id, for example `owner` */
  get id(): string {
    return this.persona.id;
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(path);
  }

  /**
   * The screenshot of the screen this persona just checked. Call it inside the test, right after the checks.
   * Waits for the boot cover to be gone and masks codes in play and password fields.
   */
  async shot(step?: string, options: ShotOptions = {}): Promise<string> {
    const file = await takeShot(
      this.page,
      shotPath(this.#testInfo, this.persona.id, step),
      this.#sensitive,
      options,
      this.#evidence,
    );
    this.shots.push(file);
    return file;
  }

  /**
   * Accessibility check of the current screen (axe, WCAG 2.1 A and AA). Findings are kept as evidence; whether
   * they fail the test is the run's choice (`ENV.A11Y=gate`).
   */
  async a11y(step = 'screen'): Promise<A11yFinding[]> {
    const results = await new AxeBuilder({ page: this.page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const findings = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      nodes: v.nodes.length,
    }));
    this.a11yFindings.push({ step, findings });
    return findings;
  }

  /** The page's aria snapshot, written to `aria/` as text an agent can read and the scrubber can clean. */
  async aria(step = 'screen'): Promise<string> {
    return writeAria(this.page, ariaPath(this.#testInfo, this.persona.id, step));
  }

  /**
   * Call the API as this persona, with the browser's own cookies (the server's answer to this person's session,
   * as the app would get it). The API origin only, no redirect followed; never throws on an error status.
   */
  async api<T = unknown>(path: string, options: PersonaApiOptions = {}): Promise<PersonaApiResponse<T>> {
    const method = options.method ?? 'GET';
    const url = new URL(path, this.#apiOrigin);
    // context.request is not covered by the guard's routes: only the API's own origin, and no redirects followed.
    if (url.origin !== this.#apiOrigin)
      throw new Error(`persona.api() only calls ${this.#apiOrigin} (got ${url.origin})`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const csrf = this.#signals.csrf;
    if (csrf && method !== 'GET') {
      const cookies = await this.context.cookies(this.#apiOrigin);
      const token = cookies.find((c) => c.name === csrf.cookie)?.value;
      if (token) headers[csrf.header] = token;
    }
    Object.assign(headers, options.headers ?? {});
    const res = await this.context.request.fetch(url.toString(), {
      method,
      headers,
      data: options.data,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return {
      http: res.status(),
      data,
      signal: this.#signals.apiError({ url, status: res.status(), json: data ?? undefined }),
    };
  }

  /** Has this browser shown a screen of the app? */
  get openedScreen(): boolean {
    return this.page.url() !== 'about:blank';
  }
}
