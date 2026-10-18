// Stand-in for src/core/secret.ts (Task 1): the `Secret` class and the key handover reader. Same behaviour as the
// private original, generic names.
import fs from 'node:fs';
import type { SecretValue } from '../../types.ts';
import { ENV } from '../../types.ts';

const REDACTED = '[redacted]';
const registered = new Set<string>();

/** A value that must never be printed; `reveal()` is the only way to read it. */
export class Secret implements SecretValue {
  readonly #value: string;
  readonly label: string;

  constructor(value: string, label: string) {
    if (!value) throw new Error(`empty secret: ${label}`);
    this.#value = value;
    this.label = label;
    registerSecretValue(value);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `${this.label}=${REDACTED}`;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${this.label})`;
  }
}

/** Remember a value so any text leaving the process can have it replaced. Values under 6 characters are ignored. */
export function registerSecretValue(value: string | null | undefined): void {
  if (!value || value.length < 6) return;
  registered.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) registered.add(encoded);
}

/** Every value registered so far (for the redactor). */
export function registeredSecrets(): string[] {
  return [...registered];
}

/**
 * The runner key as the CLI hands it over: the file named by `CREDLESS_RUNNER_KEY_FILE`, read once and deleted in a
 * `finally`, the variable removed from the environment. Falls back to `CREDLESS_RUNNER_KEY` (taken over and removed).
 * Null when neither is there.
 */
export function runnerKeyFromRunner(env: NodeJS.ProcessEnv = process.env): Secret | null {
  const file = env[ENV.RUNNER_KEY_FILE];
  if (file) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8').trim();
    } catch {
      raw = '';
    } finally {
      fs.rmSync(file, { force: true });
      delete env[ENV.RUNNER_KEY_FILE];
    }
    if (raw) return new Secret(raw, 'runner key');
  }
  const inline = env[ENV.RUNNER_KEY];
  delete env[ENV.RUNNER_KEY];
  return inline?.trim() ? new Secret(inline.trim(), 'runner key') : null;
}
