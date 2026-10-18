// Every text inside a run folder, wherever it hides: plain files, zips (traces, the blob report, the HTML report's
// data files), zips inside zips, the base64 zip embedded in the HTML report's index.html, and base64 attachment bodies
// inside JSON. One visitor sees them all, in read-only mode for the scan and in write mode for the scrub.
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { EVIDENCE } from '../types.ts';

/** Files never opened: images, fonts, videos. A secret inside one is out of this pipeline's reach (SECURITY.md). */
export const BINARY_EXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.webm',
  '.mp4',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
]);

const EMBEDDED_ZIP = /(data:application\/zip;base64,)([A-Za-z0-9+/=]+)/g;
// Base64 attachment bodies inside JSON (results.json `body`, HAR `text`): 16 characters or more, so a short word in
// a JSON value is not mistaken for one.
const B64_BODY = /("(?:body|text)"\s*:\s*")([A-Za-z0-9+/]{16,}={0,2})(")/g;

/** Sees one text; returns the replacement, or null to leave it as it is. `where` names the file and the path inside it. */
export type TextVisitor = (text: string, where: string) => string | null;

export interface VisitOptions {
  /** write changed texts back (the scrub); the scan never writes */
  write: boolean;
}

export interface VisitOutcome {
  /** files opened */
  files: number;
  /** things that could not be looked into, named by file; never a value */
  problems: string[];
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 2048)).includes(0);
}

function isPrintable(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are how a decoded body shows it is not text
  return !/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4096));
}

/** Every regular file under `dir`, depth first. Symbolic links are left alone: the evidence folder has none. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Base64 attachment bodies inside JSON: decode, apply, re-encode (only when the visitor changed the text). */
export function mapBase64Bodies(text: string, onText: TextVisitor, label: string): string {
  return text.replace(B64_BODY, (m, a: string, b64: string, c: string) => {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    if (!isPrintable(decoded)) return m;
    const next = onText(decoded, `${label}#body`);
    return next !== null && next !== decoded ? `${a}${Buffer.from(next, 'utf8').toString('base64')}${c}` : m;
  });
}

/** Apply the visitor to every text inside a zip, zips inside it included; returns new zip bytes, or null if unchanged. */
export function mapZip(
  bytes: Uint8Array,
  onText: TextVisitor,
  label: string,
): { bytes: Uint8Array<ArrayBuffer> | null; problems: string[] } {
  let entries: ReturnType<typeof unzipSync>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { bytes: null, problems: [`${label}: not a readable zip`] };
  }
  let changed = false;
  const problems: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const inner = `${label}!${name}`;
    if (name.endsWith('.zip')) {
      const nested = mapZip(data, onText, inner);
      problems.push(...nested.problems);
      if (nested.bytes) {
        entries[name] = nested.bytes;
        changed = true;
      }
      continue;
    }
    if (BINARY_EXT.has(path.extname(name).toLowerCase()) || looksBinary(data)) continue;
    const text = strFromU8(data);
    const next = onText(mapBase64Bodies(text, onText, inner), inner);
    if (next !== null && next !== text) {
      entries[name] = strToU8(next);
      changed = true;
    }
  }
  return { bytes: changed ? zipSync(entries, { level: 6 }) : null, problems };
}

/**
 * Visit every text in the run folder. `where` is the file's path relative to the folder with `/` separators, then
 * `!entry` for a zip entry, `#embedded` for the HTML report's zip and `#body` for a base64 body, so a finding can be
 * traced back to the file to quarantine (`topFile`).
 */
export function visitTexts(dir: string, onText: TextVisitor, options: VisitOptions): VisitOutcome {
  const problems: string[] = [];
  let files = 0;
  for (const file of walkFiles(dir)) {
    // The HMAC list is the fixtures' and post-run deletes it; it holds no value and is not evidence.
    if (path.basename(file) === EVIDENCE.sensitiveHashes) continue;
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    const bytes = fs.readFileSync(file);
    const rel = path.relative(dir, file).split(path.sep).join('/');
    files += 1;
    if (ext === '.zip') {
      const result = mapZip(bytes, onText, rel);
      problems.push(...result.problems);
      if (options.write && result.bytes) fs.writeFileSync(file, result.bytes);
      continue;
    }
    if (looksBinary(bytes)) continue;
    const original = bytes.toString('utf8');
    let text = original.replace(EMBEDDED_ZIP, (m, prefix: string, b64: string) => {
      const result = mapZip(Buffer.from(b64, 'base64'), onText, `${rel}#embedded`);
      problems.push(...result.problems);
      return result.bytes ? `${prefix}${Buffer.from(result.bytes).toString('base64')}` : m;
    });
    text = mapBase64Bodies(text, onText, rel);
    const next = onText(text, rel) ?? text;
    if (options.write && next !== original) fs.writeFileSync(file, next);
  }
  return { files, problems };
}

/** The file on disk a `where` label points into (`html/index.html#embedded!report.json` is `html/index.html`). */
export function topFile(where: string): string {
  return where.split(/[!#]/)[0] ?? where;
}

/** The absolute path of a `where` label's file, whatever the platform's separator. */
export function fileOf(dir: string, where: string): string {
  return path.join(dir, ...topFile(where).split('/'));
}
