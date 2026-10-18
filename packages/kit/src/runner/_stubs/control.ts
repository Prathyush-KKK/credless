// Stand-in for src/core/control.ts (Task 1): the core methods the runner's commands need (health, ensure, reset,
// cleanupRun). The rest throws; the real class ports the private control.
import type {
  Catalog,
  CleanupResult,
  ControlOptions,
  Health,
  MailMatch,
  MailQuery,
  MailWaitOptions,
  Message,
  Persona,
  PersonaRef,
  PersonaSpec,
  PersonaState,
  ResetResult,
  StateControl,
  TestApiClient,
} from '../../types.ts';

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
}

export class Control implements StateControl {
  readonly ns: string;
  readonly runId: string;
  readonly touched = new Set<string>();
  readonly created = new Map<string, Set<string>>();
  readonly #api: TestApiClient;
  readonly #catalog: Catalog;

  constructor(options: ControlOptions) {
    this.ns = options.ns;
    this.runId = options.runId;
    this.#api = options.api;
    this.#catalog = options.catalog;
  }

  async health(): Promise<Health> {
    return (await this.#api.call<Health>('health')).data;
  }

  persona(id: string): Persona {
    const entry = this.#catalog.personas[id];
    if (!entry) throw new Error(`unknown persona: ${id}`);
    const d = this.#catalog.defaults;
    const lastName = render(this.#catalog.lastNameTemplate, { ns: this.ns });
    return {
      id,
      ns: this.ns,
      handle: this.handle(id),
      email: render(this.#catalog.addressTemplate, { ns: this.ns, persona: id }),
      firstName: entry.firstName,
      lastName,
      displayName: `${entry.firstName} ${lastName}`,
      role: entry.role,
      auth: entry.auth ?? d.auth,
      locale: entry.locale ?? d.locale,
      timezone: entry.timezone ?? d.timezone,
      countryCode: entry.countryCode ?? d.countryCode,
      attributes: entry.attributes ?? {},
    };
  }

  handle(id: string): string {
    return `${this.ns}.${id}`;
  }

  address(to: string): string {
    if (this.#catalog.personas[to]) return this.persona(to).email;
    const address = this.#catalog.addresses?.[to];
    if (!address) throw new Error(`unknown persona or address: ${to}`);
    return render(address.template, { ns: this.ns });
  }

  async ensure(ids: string[]): Promise<PersonaRef[]> {
    const personas: PersonaSpec[] = ids.map((id) => {
      const p = this.persona(id);
      return {
        handle: p.handle,
        email: p.email,
        displayName: p.displayName,
        attributes: {
          role: p.role,
          firstName: p.firstName,
          lastName: p.lastName,
          locale: p.locale,
          timezone: p.timezone,
          countryCode: p.countryCode,
          auth: p.auth,
          ...p.attributes,
        },
      };
    });
    return (await this.#api.call<PersonaRef[]>('ensurePersonas', { body: { personas } })).data;
  }

  async reset(ids: string[]): Promise<void> {
    await this.#api.call<ResetResult[]>('resetPersonas', { body: { handles: ids.map((id) => this.handle(id)) } });
  }

  async state(id: string): Promise<PersonaState> {
    return (await this.#api.call<PersonaState>('personaState', { params: { handle: this.handle(id) } })).data;
  }

  async messages(_to: string, _query?: MailQuery): Promise<Message[]> {
    throw new Error('stand-in Control: messages() lands with Task 1');
  }

  async waitForMessage(_to: string, _match: MailMatch, _options?: MailWaitOptions): Promise<Message> {
    throw new Error('stand-in Control: waitForMessage() lands with Task 1');
  }

  async teardown(): Promise<string[]> {
    return [];
  }

  async cleanupRun(): Promise<CleanupResult> {
    return (
      await this.#api.call<CleanupResult>('cleanupRun', {
        params: { runId: this.runId },
        body: { revokeSessions: true },
      })
    ).data;
  }
}
