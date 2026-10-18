// Stand-in for src/evidence/redactor.ts (Task 3): a Transform that replaces registered secret values in a child's
// stdio. Keeps a tail so a value split across two chunks is still caught.
import { Transform, type TransformCallback } from 'node:stream';
import { registeredSecrets } from './secret.ts';

const REDACTED = '[redacted]';

export class Redactor extends Transform {
  readonly #values = new Set<string>();
  #tail = '';

  constructor(values: Iterable<string> = []) {
    super();
    for (const v of registeredSecrets()) this.add(v);
    for (const v of values) this.add(v);
  }

  /** Register one more value (6 characters or longer) to replace. */
  add(value: string | null | undefined): void {
    if (!value || value.length < 6) return;
    this.#values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.#values.add(encoded);
  }

  /** Replace every registered value in a string. */
  redact(text: string): string {
    let out = text;
    for (const v of this.#values) out = out.split(v).join(REDACTED);
    return out;
  }

  get #longest(): number {
    let n = 0;
    for (const v of this.#values) n = Math.max(n, v.length);
    return n;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.#tail + chunk.toString();
    const keep = Math.max(0, this.#longest - 1);
    const cut = Math.max(0, text.length - keep);
    // Everything up to a line break is safe to flush; the rest waits in case a value straddles the boundary.
    const boundary = text.lastIndexOf('\n', text.length - 1);
    const split = boundary >= cut ? boundary + 1 : cut;
    this.#tail = text.slice(split);
    callback(null, this.redact(text.slice(0, split)));
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.#tail;
    this.#tail = '';
    callback(null, this.redact(rest));
  }
}
