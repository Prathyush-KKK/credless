// Which of Playwright's browsers are installed for a project, asked of the project's own @playwright/test (where each
// executable would live); nothing is launched and nothing is downloaded. Doctor lists them; `demo` refuses to start
// without Chromium and prints the one command that installs it.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

type Browsers = Record<BrowserName, { executablePath(): string }>;

/** The browsers of `names` whose executable is missing; null when @playwright/test does not load from `projectRoot`. */
export async function missingBrowsers(
  projectRoot: string,
  names: readonly BrowserName[],
): Promise<BrowserName[] | null> {
  let pw: Browsers;
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    // A CommonJS module: its exports sit on `default` when the lexer cannot name them.
    const mod = (await import(pathToFileURL(require.resolve('@playwright/test')).href)) as Browsers & {
      default?: Browsers;
    };
    pw = mod.default?.chromium ? mod.default : mod;
  } catch {
    return null;
  }
  return names.filter((name) => {
    try {
      return !fs.existsSync(pw[name].executablePath());
    } catch {
      return true;
    }
  });
}

/**
 * The command that installs Chromium for the Playwright a project resolves. The version is pinned when known: browser
 * builds belong to one Playwright release, and from a directory without a local Playwright (the npx cache) a bare
 * `npx playwright` would fetch whatever is latest.
 */
export function chromiumInstallCommand(playwrightVersion: string | null): string {
  return `npx playwright${playwrightVersion ? `@${playwrightVersion}` : ''} install chromium`;
}
