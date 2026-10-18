// The redacting stream a child's stdout and stderr pass through (the CLI spawns Playwright with this on both), and
// the one-shot form for a string. Replaces the private framework's `| filter` shell pipe, so it works the same on
// Windows and never involves a shell.

import fs from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { EVIDENCE } from '../types.ts';
import {
  collectCookieValues,
  type PreparedValue,
  prepareValues,
  readHashLines,
  revealAll,
  type SecretLike,
  type SecretShapes,
  type ShapeOptions,
  scrubText,
  shapesForRun,
  stripAnsi,
} from './patterns.ts';

export interface RedactorOptions extends ShapeOptions {
  /** values redacted wherever they appear, in any encoding */
  values?: Iterable<SecretLike>;
  /** the live run folder: its `.sensitive-hashes` is re-read as the fixtures append codes during the run */
  dir?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what a terminal colour code starts with
const HAS_ANSI = /\u001b\[/;

/**
 * Redacts text line by line as it flows: registered values (also when a colour code splits them), collected cookie
 * and header values, and everything secret-shaped. A line that needs no redaction passes through untouched, colours
 * included; a line that does is written plain, because the colour codes inside a value are what hid it.
 */
export class Redactor extends Transform {
  readonly #shapes: SecretShapes;
  #values: PreparedValue[];
  readonly #known = new Set<string>();
  readonly #collected = new Set<string>();
  readonly #decoder = new StringDecoder('utf8');
  readonly #hashFile: string | null;
  #hashSize = -1;
  #rest = '';

  constructor(options: RedactorOptions = {}) {
    super();
    this.#shapes = shapesForRun(options.dir, options);
    for (const v of revealAll(options.values)) this.#known.add(v);
    this.#values = prepareValues(this.#known);
    this.#hashFile = options.dir ? path.join(options.dir, EVIDENCE.sensitiveHashes) : null;
  }

  /** Register one more value (a secret revealed after the stream started). */
  add(value: SecretLike): void {
    const before = this.#known.size;
    for (const v of revealAll([value])) this.#known.add(v);
    if (this.#known.size !== before) this.#values = prepareValues(this.#known);
  }

  /** Redact one line (no trailing newline). */
  redactLine(line: string): string {
    this.#refreshHashes();
    collectCookieValues(line, this.#shapes, this.#collected);
    const values = this.#collected.size ? [...this.#values, ...prepareValues(this.#collected)] : this.#values;
    if (!HAS_ANSI.test(line)) return scrubText(line, this.#shapes, values).text;
    const plain = stripAnsi(line);
    const scrubbed = scrubText(plain, this.#shapes, values).text;
    return scrubbed === plain ? line : scrubbed;
  }

  #refreshHashes(): void {
    if (!this.#hashFile) return;
    try {
      const size = fs.statSync(this.#hashFile).size;
      if (size !== this.#hashSize) {
        this.#hashSize = size;
        this.#shapes.addHashes(readHashLines(this.#hashFile));
      }
    } catch {
      // no codes handed out yet
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.#rest + this.#decoder.write(chunk);
    const lines = text.split('\n');
    this.#rest = lines.pop() ?? '';
    for (const line of lines) this.push(`${this.redactLine(line)}\n`);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const tail = this.#rest + this.#decoder.end();
    this.#rest = '';
    if (tail) this.push(this.redactLine(tail));
    callback();
  }
}

/** Redact a whole string at once (multi-line; the same rules as the stream). */
export function redactString(text: string, options: RedactorOptions = {}): string {
  const redactor = new Redactor(options);
  return text
    .split('\n')
    .map((line) => redactor.redactLine(line))
    .join('\n');
}
