// Playwright 1.65 added `use.trace.secrets`: values rendered as `<secret>NAME</secret>` in traces. The kit sets it
// for the values it knows when the config loads, when the installed Playwright has it, and keeps the scrub for the
// values a run discovers later (codes, cookies), which a static option cannot cover. The scan treats
// `<secret>…</secret>` as redacted text (plan §6).
import { createRequire } from 'node:module';
import type { TraceMode } from '../types.ts';
import type { SecretLike } from './patterns.ts';

/** The first Playwright version with `trace.secrets`. */
export const TRACE_SECRETS_SINCE = '1.65.0';

/** One entry of the `secrets` option: the value, and the name the trace shows in its place. */
export interface TraceSecret {
  name?: string;
  value: SecretLike;
}

/** The `trace` use-option in its object form (`{ mode, secrets }`), as 1.65 takes it. */
export interface TraceUseOption {
  mode: TraceMode;
  secrets?: Array<{ name?: string; value: string }>;
}

/** The installed `@playwright/test` version, or null when it cannot be found from here. */
export function installedPlaywrightVersion(): string | null {
  try {
    const pkg: unknown = createRequire(import.meta.url)('@playwright/test/package.json');
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  const pb = b.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Does this Playwright render `trace.secrets`? Feature-detected by version; a pre-release of 1.65 counts. */
export function traceSecretsSupported(version: string | null = installedPlaywrightVersion()): boolean {
  return version !== null && compareVersions(version, TRACE_SECRETS_SINCE) >= 0;
}

/**
 * The `trace` use-option for a run: the object form with `secrets` when Playwright supports it, the plain mode
 * otherwise. `reveal()` is called here because Playwright needs the value to recognise it; the option travels to
 * workers with the config, which is why only values the workers hold anyway (the sign-in password they type, the
 * broker token they send) belong here, never the runner key.
 */
export function traceOption(
  mode: TraceMode,
  secrets: readonly TraceSecret[],
  version?: string | null,
): TraceMode | TraceUseOption {
  if (secrets.length === 0 || !traceSecretsSupported(version)) return mode;
  return {
    mode,
    secrets: secrets.map(({ name, value }) => ({ name, value: typeof value === 'string' ? value : value.reveal() })),
  };
}
