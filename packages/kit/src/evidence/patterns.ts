// What "secret-shaped" means to the scrub, the scan and the redactor, compiled once per run from the config's names.
//
// The patterns are a safety net, not a proof: a secret in a shape they do not know, or inside an image, would pass.
// What keeps secrets out in the first place is upstream (typeSecret, masked screenshots, the broker, no screencast
// frames in traces); a secret VALUE found here, even once scrubbed, means one of those leaked, and post-run fails the
// run for it.
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, EVIDENCE, type SecretValue } from '../types.ts';

/** A secret as the kit passes it around: the `Secret` class, or a plain string from a file the CLI read. */
export type SecretLike = string | SecretValue;

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** Values shorter than this are never registered: they would redact ordinary words (docs/conventions.md §8). */
export const MIN_SECRET_LENGTH = 6;

/** Header names whose values are credentials wherever they appear; a config's `testApi.keyHeader` joins the list. */
export const DEFAULT_HEADER_NAMES: readonly string[] = [
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-csrf-token',
  'x-xsrf-token',
  'x-auth-token',
  'x-api-key',
  DEFAULTS.keyHeader.toLowerCase(),
  DEFAULTS.brokerTokenHeader.toLowerCase(),
];

/** Cookie names treated as sessions when no config says otherwise (`signals.sessionCookies`, the CSRF cookie). */
export const DEFAULT_COOKIE_NAMES: readonly string[] = ['sid', 'csrf'];

/** The knobs every secret-shape consumer takes; all optional, all from the config or the run's environment. */
export interface ShapeOptions {
  /** cookie names treated as sessions; {@link DEFAULT_COOKIE_NAMES} stay in the list */
  cookieNames?: readonly string[];
  /** header names whose values are credentials; {@link DEFAULT_HEADER_NAMES} stay in the list */
  headerNames?: readonly string[];
  /** `digits6` (default) or a regular expression source for what counts as a one-time code */
  codeShape?: string;
  /** the HMAC key of `.sensitive-hashes` and of `codes` (`ENV.EVIDENCE_KEY`); falls back to the run id */
  evidenceKey?: string;
  /** codes this process knows in plain; hashed under the evidence key like the fixtures' list, never kept in plain */
  codes?: readonly string[];
  /** HMACs of codes (the lines of `.sensitive-hashes`) known without the file */
  codeHashes?: Iterable<string>;
  /** app-defined shapes, kind to pattern: the scan reports them under that kind, the scrub replaces them */
  patterns?: Record<string, RegExp | string>;
}

// Terminal colour codes, raw or JSON-escaped: Playwright's diffs put them inside values ("418<ESC>[7m <ESC>[27m203"),
// where they would split a secret past every pattern. Removed before anything is matched, and from what is kept.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what a terminal colour code starts with
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\\u001[bB]\[[0-9;?]*[A-Za-z]/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// Six digits, as one run or 3 + 3 with a space, no-break or thin space, or a hyphen between.
const CODE_DIGITS6 = /(?<![0-9])\d{3}[    -]?\d{3}(?![0-9])/g;
const CODE_SEPARATORS = /[    -]/g;
// A cookie object as Playwright records it (addCookies, storage state): any name, the value before its domain or url.
const COOKIE_OBJECT =
  /("name"\s*:\s*"[^"]{1,64}"\s*,\s*"value"\s*:\s*")((?:[^"\\]|\\.)*)("\s*,\s*"(?:domain|url|path)")/g;
const COOKIE_HEADER_PAIR = /"name"\s*:\s*"(cookie|set-cookie)"\s*,\s*"value"\s*:\s*"((?:[^"\\]|\\.)*)"/gi;
const COOKIE_HEADER_KEY = /"(cookie|set-cookie)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi;
const COOKIE_HEADER_LINE = /^\s*(cookie|set-cookie)\s*:\s*(.+)$/gim;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withGlobalFlag(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern, 'g');
  return pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

/** Already redacted, by us (`[redacted…]`) or by Playwright 1.65's trace `secrets` option (`<secret>NAME</secret>`). */
export function isRedacted(value: string): boolean {
  return value === '' || value.startsWith('[redacted') || /^<secret>[^<]*<\/secret>$/.test(value);
}

const REDACTION_SPANS = /<secret>[^<]*<\/secret>|\[redacted[^\]]*\]/g;

/**
 * Is a header or cookie value redacted as a whole? True for `[redacted…]` and `<secret>NAME</secret>`, and for a
 * cookie list whose every pair's value is one of those (`sid=<secret>session</secret>; csrf=[redacted]`). For a
 * Set-Cookie header only the first pair counts; its attributes (Path, SameSite=Lax) are not values.
 */
export function valueRedacted(value: string, header = ''): boolean {
  if (isRedacted(value)) return true;
  const scope = /set-cookie/i.test(header) ? (value.split(';')[0] ?? '') : value;
  const rest = scope
    .replace(REDACTION_SPANS, '')
    .replace(/[A-Za-z0-9_.-]+=/g, '')
    .replace(/[;,\s]/g, '');
  return rest === '';
}

/** Remove terminal colour codes, raw or JSON-escaped. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The text, and the text with one level of JSON string escaping undone (JSON inside a JSON string). */
export function views(text: string): string[] {
  const plain = stripAnsi(text);
  // One pass, left to right, so an escaped backslash is never re-read as the start of an escaped quote.
  const decoded = plain.replace(/\\(\\|")/g, '$1');
  return decoded === plain ? [plain] : [plain, decoded];
}

/**
 * The base64 of a value as it appears inside a longer base64 stream: one fragment per byte alignment, cut to the
 * characters the value alone determines. Fragments under 8 characters are dropped (too likely by chance).
 */
function base64Fragments(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const out: string[] = [];
  for (let k = 0; k < 3; k += 1) {
    const encoded = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const fragment = encoded.slice(Math.ceil((4 * k) / 3), Math.floor((4 * (k + bytes.length)) / 3));
    if (fragment.length >= 8) out.push(fragment);
  }
  return out;
}

/** A value as it can appear in reports: plain, URL-encoded, JSON-escaped once and twice, base64 at any alignment. */
export function formsOf(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [...new Set([value, encodeURIComponent(value), once, twice, ...base64Fragments(value)])].filter(Boolean);
}

/** A value with its encodings computed once, for the many texts of a run. */
export interface PreparedValue {
  value: string;
  forms: string[];
}

export function prepareValues(values: Iterable<string>): PreparedValue[] {
  const seen = new Set<string>();
  const out: PreparedValue[] = [];
  for (const value of values) {
    if (seen.has(value) || value.length < MIN_SECRET_LENGTH) continue;
    seen.add(value);
    out.push({ value, forms: formsOf(value) });
  }
  return out;
}

/** Plain strings out of secrets; `reveal()` is called here on purpose, the only place the pipeline reads a value. */
export function revealAll(values: Iterable<SecretLike> | undefined): string[] {
  const out = new Set<string>();
  for (const v of values ?? []) {
    const text = typeof v === 'string' ? v : v.reveal();
    if (text.length >= MIN_SECRET_LENGTH) out.add(text);
  }
  return [...out];
}

/** How often the values occur in a text, in any of their encodings (colour codes removed first). */
export function countValues(text: string, values: readonly PreparedValue[]): number {
  if (values.length === 0) return 0;
  const plain = stripAnsi(text);
  let n = 0;
  for (const { forms } of values) {
    for (const form of forms) n += plain.split(form).length - 1;
  }
  return n;
}

function redactValues(text: string, values: readonly PreparedValue[]): { text: string; replaced: number } {
  let out = text;
  let replaced = 0;
  // Longest first: a header value that contains a registered value (`Bearer <key>`) must go as a whole, or the
  // shorter replacement would leave `Bearer [redacted]`, which is not a redacted header.
  const longestFirst = [...values].sort((a, b) => b.value.length - a.value.length);
  for (const { forms } of longestFirst) {
    for (const form of forms) {
      if (out.includes(form)) {
        const parts = out.split(form);
        replaced += parts.length - 1;
        out = parts.join(REDACTED);
      }
    }
  }
  return { text: out, replaced };
}

/**
 * The compiled shapes of one run: credential headers and session cookies by the configured names, JWTs, one-time
 * codes by HMAC under the evidence key, and the app's own patterns.
 */
export class SecretShapes {
  readonly headerNames: readonly string[];
  readonly cookieNames: readonly string[];
  readonly evidenceKey: string;
  /** HMACs of the codes in play; grows while a run goes on (`.sensitive-hashes` is appended by the fixtures) */
  readonly hashes = new Set<string>();
  readonly jsonPair: RegExp;
  readonly jsonPairReversed: RegExp;
  readonly jsonHeaderKey: RegExp;
  readonly cookieObject: RegExp = COOKIE_OBJECT;
  readonly headerLine: RegExp;
  readonly cookieValue: RegExp;
  readonly jwt: RegExp = JWT;
  readonly code: RegExp;
  readonly extra: ReadonlyArray<{ kind: string; pattern: RegExp }>;
  #codeCache = new Map<string, boolean>();

  constructor(options: ShapeOptions = {}) {
    this.headerNames = [
      ...new Set([...DEFAULT_HEADER_NAMES, ...(options.headerNames ?? []).map((h) => h.toLowerCase())]),
    ];
    this.cookieNames = [...new Set([...DEFAULT_COOKIE_NAMES, ...(options.cookieNames ?? [])])];
    this.evidenceKey = options.evidenceKey ?? '';
    const headers = this.headerNames.map(escapeRegExp).join('|');
    const names = [...this.headerNames, ...this.cookieNames].map(escapeRegExp).join('|');
    const cookies = this.cookieNames.map(escapeRegExp).join('|');
    const quoted = '((?:[^"\\\\]|\\\\.)*)';
    this.jsonPair = new RegExp(`("name"\\s*:\\s*"(?:${names})"\\s*,\\s*"value"\\s*:\\s*")${quoted}(")`, 'gi');
    this.jsonPairReversed = new RegExp(`("value"\\s*:\\s*")${quoted}("\\s*,\\s*"name"\\s*:\\s*"(?:${names})")`, 'gi');
    // Headers as a JSON object: {"cookie": "...", "Authorization": "..."}
    this.jsonHeaderKey = new RegExp(`("(?:${headers})"\\s*:\\s*")${quoted}(")`, 'gi');
    // A header line (logs, error contexts). The lookahead sits right after the colon, so spaces cannot be given back
    // to let an already-redacted line match again.
    this.headerLine = new RegExp(`^(\\s*(?:${headers})\\s*:)(?!\\s*(?:\\[redacted|<secret>))(\\s*\\S.*)$`, 'gim');
    this.cookieValue = new RegExp(`((?<![A-Za-z0-9_-])(?:${cookies})=)(?!\\[redacted\\]|<secret>)[^;\\s"'\\\\]+`, 'g');
    const shape = options.codeShape ?? DEFAULTS.codeShape;
    this.code = shape === 'digits6' ? CODE_DIGITS6 : new RegExp(shape, 'g');
    this.extra = Object.entries(options.patterns ?? {}).map(([kind, pattern]) => ({
      kind,
      pattern: withGlobalFlag(pattern),
    }));
    this.addHashes(options.codeHashes ?? []);
    this.addCodes(options.codes ?? []);
  }

  /** Normalise a matched code the way the fixtures hash it: separators removed. */
  static normaliseCode(matched: string): string {
    return matched.replace(CODE_SEPARATORS, '');
  }

  hashOf(code: string): string {
    return createHmac('sha256', this.evidenceKey).update(SecretShapes.normaliseCode(code)).digest('hex');
  }

  addHashes(lines: Iterable<string>): void {
    for (const line of lines) {
      const h = line.trim();
      if (h) this.hashes.add(h);
    }
    this.#codeCache.clear();
  }

  addCodes(codes: Iterable<string>): void {
    for (const code of codes) this.hashes.add(this.hashOf(code));
    this.#codeCache.clear();
  }

  /** Is this matched number one of the run's codes? Decided by HMAC, so the list never holds a code in plain. */
  isCode(matched: string): boolean {
    if (this.hashes.size === 0) return false;
    const digits = SecretShapes.normaliseCode(matched);
    const cached = this.#codeCache.get(digits);
    if (cached !== undefined) return cached;
    const hit = this.hashes.has(this.hashOf(digits)) || (digits !== matched && this.hashes.has(this.hashOf(matched)));
    // Bounded: a trace can hold a great many six-digit numbers.
    if (this.#codeCache.size > 50_000) this.#codeCache.clear();
    this.#codeCache.set(digits, hit);
    return hit;
  }
}

function runIdOf(dir: string): string {
  try {
    const meta: unknown = JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE.run), 'utf8'));
    const runId = (meta as { runId?: unknown }).runId;
    return typeof runId === 'string' ? runId : '';
  } catch {
    return ''; // no or a damaged run.json: the shapes work without it, the key only matters for the code list
  }
}

/**
 * The shapes for one run folder: the options plus the HMAC list the fixtures left in `.sensitive-hashes`. Without an
 * evidence key the run id stands in, as the fixtures do when no runner set one (a plain `playwright test`).
 */
export function shapesForRun(dir: string | undefined, options: ShapeOptions = {}): SecretShapes {
  const evidenceKey = options.evidenceKey ?? (dir ? runIdOf(dir) : '');
  const shapes = new SecretShapes({ ...options, evidenceKey });
  if (dir) shapes.addHashes(readHashLines(path.join(dir, EVIDENCE.sensitiveHashes)));
  return shapes;
}

/** The lines of a hash file, or none when it is not there yet. */
export function readHashLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * Credential values seen anywhere in a text, to redact them everywhere by value: cookie values (headers and cookie
 * objects) and the values of credential headers, in the text as it is and with one level of JSON escaping undone.
 */
export function collectCookieValues(text: string, shapes: SecretShapes, into: Set<string>): Set<string> {
  const add = (raw: string | undefined): void => {
    const value = (raw ?? '').trim();
    if (value.length >= MIN_SECRET_LENGTH && !isRedacted(value) && !/\[redacted|<secret>/.test(value)) into.add(value);
  };
  const pairs = (headerName: string, headerValue: string): void => {
    // A Set-Cookie line's attributes (Path, SameSite=Strict) are not values: only its first pair is.
    const source = headerName.toLowerCase() === 'set-cookie' ? (headerValue.split(';')[0] ?? '') : headerValue;
    for (const part of source.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) add(part.slice(eq + 1));
    }
  };
  for (const view of views(text)) {
    for (const m of view.matchAll(COOKIE_HEADER_PAIR)) pairs(m[1] ?? '', m[2] ?? '');
    for (const m of view.matchAll(COOKIE_HEADER_KEY)) pairs(m[1] ?? '', m[2] ?? '');
    for (const m of view.matchAll(COOKIE_HEADER_LINE)) pairs(m[1] ?? '', m[2] ?? '');
    for (const m of view.matchAll(shapes.cookieObject)) add(m[2]);
    for (const re of [shapes.jsonPair, shapes.jsonPairReversed, shapes.jsonHeaderKey]) {
      for (const m of view.matchAll(re)) {
        if (/"(?:set-)?cookie"/i.test(m[0])) continue; // cookie headers: split into pairs above
        add(m[2]);
      }
    }
  }
  return into;
}

/** Redact one text: the values in every encoding, then everything secret-shaped. */
export function scrubText(
  text: string,
  shapes: SecretShapes,
  values: readonly PreparedValue[],
): { text: string; replaced: number } {
  const byValue = redactValues(stripAnsi(text), values);
  let out = byValue.text;
  let n = byValue.replaced;
  const keepRedacted = (m: string, a: string, v: string, c: string): string => {
    if (valueRedacted(v, m)) return m;
    n += 1;
    return `${a}${REDACTED}${c}`;
  };
  out = out.replace(shapes.jsonPair, keepRedacted);
  out = out.replace(shapes.jsonPairReversed, keepRedacted);
  out = out.replace(shapes.jsonHeaderKey, keepRedacted);
  out = out.replace(shapes.cookieObject, keepRedacted);
  out = out.replace(shapes.headerLine, (m, a: string, v: string) => {
    if (valueRedacted(v, a)) return m;
    n += 1;
    return `${a} ${REDACTED}`;
  });
  out = out.replace(shapes.cookieValue, (_m, a: string) => {
    n += 1;
    return `${a}${REDACTED}`;
  });
  out = out.replace(shapes.jwt, () => {
    n += 1;
    return '[redacted-jwt]';
  });
  out = out.replace(shapes.code, (m) => {
    if (!shapes.isCode(m)) return m;
    n += 1;
    return '[redacted-code]';
  });
  for (const { kind, pattern } of shapes.extra) {
    out = out.replace(pattern, () => {
      n += 1;
      return `[redacted-${kind}]`;
    });
  }
  return { text: out, replaced: n };
}

/** What is still there, by kind (no values). `cookieValues` are the ones the scrub collected. */
export function findInText(
  text: string,
  shapes: SecretShapes,
  values: readonly PreparedValue[],
  cookieValues: readonly PreparedValue[] = [],
): Record<string, number> {
  const found: Record<string, number> = {};
  const add = (kind: string, k: number): void => {
    if (k > 0) found[kind] = (found[kind] ?? 0) + k;
  };
  const all = views(text);
  const plain = all[0] ?? '';
  add('secret-value', countValues(plain, values));
  add('cookie-value', countValues(plain, cookieValues));
  add('jwt', (plain.match(shapes.jwt) ?? []).length);
  const unredacted = (m: RegExpMatchArray): boolean => !valueRedacted(m[2] ?? '', m[0]);
  for (const view of all) {
    const headers = [shapes.jsonPair, shapes.jsonPairReversed, shapes.jsonHeaderKey].flatMap((re) => [
      ...view.matchAll(re),
    ]);
    add('credential-header', headers.filter(unredacted).length);
    add('cookie-object', [...view.matchAll(shapes.cookieObject)].filter(unredacted).length);
  }
  add(
    'credential-header',
    [...plain.matchAll(shapes.headerLine)].filter((m) => !valueRedacted(m[2] ?? '', m[1] ?? '')).length,
  );
  add('session-cookie', (plain.match(shapes.cookieValue) ?? []).length);
  add('code', [...plain.matchAll(shapes.code)].filter((m) => shapes.isCode(m[0])).length);
  for (const { kind, pattern } of shapes.extra) add(kind, (plain.match(pattern) ?? []).length);
  return found;
}
