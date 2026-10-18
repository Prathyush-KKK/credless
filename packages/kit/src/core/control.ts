// The core state control (plan §4.2): accounts, their state, their mail, and teardown. Tests use persona ids
// (`owner`); this class maps them to the worker's accounts (`a0.owner`) and remembers what it created so teardown
// can undo it even when the test failed. Apps extend the class (plan §4.5) and reach the protected helpers.
import type {
  Catalog,
  CleanupResult,
  ControlOptions,
  Health,
  MailMatch,
  MailQuery,
  MailSink,
  MailWaitOptions,
  Message,
  Persona,
  PersonaRef,
  PersonaState,
  ResetResult,
  SecretValue,
  StateControl,
  TestApiClient,
} from '../types.ts';
import { addressFor, personaIdOf, personaSpec, resolvePersona } from './catalog.ts';
import { fillPath, pathParams } from './routes.ts';
import { Secret } from './secret.ts';
import { TestApiError } from './test-api-client.ts';

export type { ControlOptions };

/** How teardown removes one tracked object of a kind; registered by an extension with `this.removers.set(kind, fn)`. */
export type Remover = (id: string) => Promise<void>;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The protected surface matches {@link ControlInternals} (`api`, `track`, `untrack`, `secret`, `handles`); it is
 * protected rather than declared with `implements` because TypeScript cannot implement an interface with
 * non-public members.
 */
export class Control implements StateControl {
  /** personas whose server state a test touched (teardown resets them) */
  readonly touched = new Set<string>();
  /** objects this instance created and has not removed, kind to ids (the public view of the tracking list) */
  readonly created = new Map<string, Set<string>>();
  /** how to remove one object of a kind at teardown; an extension registers one per kind it tracks */
  protected readonly removers = new Map<string, Remover>();
  protected readonly api: TestApiClient;
  protected readonly catalog: Catalog;
  protected readonly mail: MailSink;
  protected readonly webOrigin: string;
  readonly #ns: string;
  readonly #runId: string;
  readonly #onSecret: ((secret: SecretValue) => void) | undefined;
  /** every tracked object in the order it was tracked; teardown walks it backwards */
  readonly #order: Array<{ kind: string; id: string }> = [];

  constructor(options: ControlOptions) {
    this.api = options.api;
    this.catalog = options.catalog;
    this.mail = options.mail;
    this.webOrigin = options.webOrigin;
    this.#ns = options.ns;
    this.#runId = options.runId;
    this.#onSecret = options.onSecret;
  }

  get ns(): string {
    return this.#ns;
  }

  get runId(): string {
    return this.#runId;
  }

  persona(id: string): Persona {
    return resolvePersona(id, this.#ns, this.catalog);
  }

  /** handle (`a0.owner`) for a persona id (`owner`) */
  handle(id: string): string {
    return this.persona(id).handle;
  }

  /** a persona id or a catalog address name to an email address in this namespace */
  address(to: string): string {
    return addressFor(to, this.#ns, this.catalog);
  }

  async health(): Promise<Health> {
    let health: Health;
    try {
      health = (await this.api.call<Health>('health')).data;
    } catch (error) {
      const detail = error instanceof TestApiError ? error.message : String(error);
      throw new Error(
        `the test API is not available on ${this.api.apiOrigin} (${detail}). The backend brief's core routes have to be on this target first.`,
      );
    }
    if (health?.enabled !== true || typeof health.keyId !== 'string' || !health.keyId) {
      throw new Error(
        `the test API on ${this.api.apiOrigin} did not answer health as the contract says; it may be off or a different service`,
      );
    }
    return { ...health, sinks: health.sinks ?? {}, extensions: health.extensions ?? [] };
  }

  /** Create (or keep) the accounts for these personas in this namespace. */
  async ensure(ids: string[]): Promise<PersonaRef[]> {
    const personas = ids.map((id) => this.persona(id));
    if (personas.length === 0) return [];
    const { data } = await this.api.call<{ personas: PersonaRef[] }>('ensurePersonas', {
      body: { personas: personas.map((p) => personaSpec(p)) },
    });
    for (const ref of data.personas) personaIdOf(ref.handle, this.#ns); // a handle outside the namespace fails here
    return data.personas;
  }

  async reset(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.api.call<{ reset: ResetResult[] }>('resetPersonas', {
      body: { handles: ids.map((id) => this.handle(id)) },
    });
    for (const id of ids) this.touched.delete(id);
  }

  async state(id: string): Promise<PersonaState> {
    return (await this.api.call<PersonaState>('personaState', { params: { handle: this.handle(id) } })).data;
  }

  /** Mail the sink captured for a persona id or an address name, newest first; every code is handed to `onSecret`. */
  async messages(to: string, query: MailQuery = {}): Promise<Message[]> {
    const messages = await this.mail.messages(this.address(to), query);
    for (const message of messages) for (const code of message.codes) this.#onSecret?.(code);
    return messages;
  }

  async waitForMessage(to: string, match: MailMatch, options: MailWaitOptions = {}): Promise<Message> {
    const message = await this.mail.waitFor(this.address(to), match, options);
    for (const code of message.codes) this.#onSecret?.(code);
    return message;
  }

  /** Remove everything created, newest first, then reset every persona touched. Returns the problems; never throws. */
  async teardown(): Promise<string[]> {
    const problems: string[] = [];
    for (const { kind, id } of [...this.#order].reverse()) {
      try {
        await this.#remove(kind, id);
      } catch (error) {
        problems.push(`remove ${kind} ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.untrack(kind, id);
    }
    const touched = [...this.touched];
    try {
      await this.reset(touched);
    } catch (error) {
      problems.push(`reset ${touched.join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return problems;
  }

  async cleanupRun(): Promise<CleanupResult> {
    return (
      await this.api.call<CleanupResult>('cleanupRun', {
        params: { runId: this.#runId },
        body: { revokeSessions: true },
      })
    ).data;
  }

  /** Remember an object for teardown; `kind` names the remover: `removers.get(kind)`, `delete<Kind>()` or the operation `delete<Kind>`. */
  protected track(kind: string, id: string): void {
    const ids = this.created.get(kind) ?? new Set<string>();
    if (ids.has(id)) return;
    ids.add(id);
    this.created.set(kind, ids);
    this.#order.push({ kind, id });
  }

  protected untrack(kind: string, id: string): void {
    const ids = this.created.get(kind);
    ids?.delete(id);
    if (ids && ids.size === 0) this.created.delete(kind);
    const at = this.#order.findIndex((o) => o.kind === kind && o.id === id);
    if (at >= 0) this.#order.splice(at, 1);
  }

  /** Wrap a value the backend handed out (an invite code), register it for masking and scrubbing. */
  protected secret(value: string, label: string): SecretValue {
    const secret = new Secret(value, label);
    this.#onSecret?.(secret);
    return secret;
  }

  /**
   * Map persona ids to handles in a request spec: strings that are persona ids, arrays of them, and the keys of a
   * nested record whose keys are all persona ids (`documents: { owner: 2 }`). The spec's own top-level keys are the
   * request's field names and are never touched, so `{ owner: 'owner' }` becomes `{ owner: 'a0.owner' }`.
   */
  protected handles<T>(spec: T): T {
    const isId = (value: string) => Boolean(this.catalog.personas[value]);
    const map = (value: unknown, top: boolean): unknown => {
      if (typeof value === 'string') return isId(value) ? this.handle(value) : value;
      if (Array.isArray(value)) return value.map((v) => map(v, false));
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const entries = Object.entries(value as Record<string, unknown>);
        const keyed = !top && entries.length > 0 && entries.every(([k]) => isId(k));
        return Object.fromEntries(entries.map(([k, v]) => [keyed ? this.handle(k) : k, map(v, false)]));
      }
      return value;
    };
    return map(spec, true) as T;
  }

  /**
   * Remove one tracked object: a registered remover, else the extension's `delete<Kind>(id)` method, else the
   * contract operation `delete<Kind>` with the id in its one path parameter. An object already gone (404) is fine.
   */
  async #remove(kind: string, id: string): Promise<void> {
    const remover = this.removers.get(kind);
    const method = `delete${capitalise(kind)}`;
    try {
      if (remover) return await remover(id);
      const own = (this as unknown as Record<string, unknown>)[method];
      if (typeof own === 'function') {
        await (own as (this: Control, id: string) => Promise<unknown>).call(this, id);
        return;
      }
      const route = this.api.routes[method];
      if (!route)
        throw new Error(
          `no remover for ${kind}: register one in removers, define ${method}(id), or add the ${method} operation to the contract`,
        );
      const [param] = pathParams(route.path);
      if (!param) throw new Error(`operation ${method} has no path parameter to carry the id`);
      fillPath(route.path, { [param]: id }); // throws early on a malformed route
      await this.api.call(method, { params: { [param]: id } });
    } catch (error) {
      if (error instanceof TestApiError && error.notFound) return;
      throw error;
    }
  }
}
