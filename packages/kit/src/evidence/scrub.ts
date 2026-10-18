// The scrub: redact, in place, everything secret in a run folder before anyone (a person, an agent) reads it.
//
// Two passes: collect every cookie and credential-header value the run's traces carry, then redact everything: the
// registered values in all their encodings, the collected values, and whatever is secret-shaped. `secretValues`
// counts the registered values found on the way; each one is a leak even though it is redacted now, and post-run
// fails the run for it.
import type { ScrubResult } from '../types.ts';
import {
  collectCookieValues,
  countValues,
  prepareValues,
  revealAll,
  type SecretLike,
  type ShapeOptions,
  scrubText,
  shapesForRun,
} from './patterns.ts';
import { visitTexts } from './walk.ts';

export interface ScrubOptions extends ShapeOptions {
  /** the run's secret values (runner key, sign-in password, broker token, codes handed out): redacted by value */
  values?: Iterable<SecretLike>;
}

/** The scrub's result, plus what it collected for the scan. */
export interface ScrubOutcome extends ScrubResult {
  /**
   * The cookie and header values collected from the evidence, for the scan's `cookie-value` kind. Not enumerable, so
   * a logged or serialised result never shows them.
   */
  readonly collected: ReadonlySet<string>;
}

/**
 * Redact a run folder in place: traces (zips, nested zips, the zip embedded in the HTML report), results.json with
 * its base64 attachment bodies, junit.xml, ctrf.json, the blob report, error contexts, logs, markdown, HAR files.
 * Returns how much was redacted and where a registered value was found; never a value.
 */
export function scrubDir(dir: string, options: ScrubOptions = {}): ScrubOutcome {
  const shapes = shapesForRun(dir, options);
  const values = prepareValues(revealAll(options.values));
  const collected = new Set<string>();
  visitTexts(
    dir,
    (text) => {
      collectCookieValues(text, shapes, collected);
      return null;
    },
    { write: false },
  );
  const everything = [...values, ...prepareValues(collected)];
  let replaced = 0;
  const secretValues: ScrubResult['secretValues'] = [];
  const { problems } = visitTexts(
    dir,
    (text, where) => {
      const hits = countValues(text, values);
      if (hits) secretValues.push({ where, count: hits });
      const result = scrubText(text, shapes, everything);
      replaced += result.replaced;
      return result.text;
    },
    { write: true },
  );
  const outcome: ScrubResult = { replaced, secretValues, cookieValues: collected.size, problems };
  Object.defineProperty(outcome, 'collected', { value: collected, enumerable: false });
  return outcome as ScrubOutcome;
}
