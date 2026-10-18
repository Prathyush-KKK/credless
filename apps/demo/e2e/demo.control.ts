// The demo's state control (plan §4.5, extension pattern): the kit's `Control` plus the workspace routes of
// apps/demo/contract/demo.openapi.yaml. Tests use persona ids (`owner`); the handles, the tracking for teardown and
// the masking of the join code happen here, so a test never sees a handle or prints a code.
import { Control, type SecretValue, type TestApiError } from 'credless/adapters';

export type MemberRole = 'owner' | 'member' | 'guest';
export type MemberState = 'ACTIVE' | 'REMOVED' | 'LEFT';
export type InviteState = 'PENDING' | 'JOINED' | 'EXPIRED' | 'LOCKED';

export interface Invite {
  id: number;
  email: string;
  state: InviteState;
  /** epoch seconds */
  expiresAt: number;
}

interface RawMember {
  handle: string;
  userId: string;
  role: MemberRole;
  state: MemberState;
}

interface RawDocument {
  id: number;
  title: string;
  uploadedBy: string;
  workspaceId: number;
  path: string;
  indexed: boolean;
}

interface RawWorkspace {
  id: number;
  name: string;
  status: 'ACTIVE' | 'DELETED';
  joinUrl: string;
  joinCode?: string;
  locked: boolean;
  members: RawMember[];
  invites: Invite[];
  documents: RawDocument[];
}

export interface DocumentRef {
  id: number;
  title: string;
  /** persona id of the uploader (`member`), not the handle */
  uploadedBy: string;
  /** the web app route, for example `/d/1004` */
  path: string;
  /** the full URL on the target's web origin */
  url: string;
  indexed: boolean;
}

export interface WorkspaceSpec {
  /** persona id of the owner */
  owner: string;
  members?: string[];
  /** read-only members */
  guests?: string[];
  /** invite targets: a persona id or a catalog address name (`ghost`) */
  invites?: Array<{ to: string; state?: 'PENDING' | 'EXPIRED' | 'LOCKED' }>;
  /** documents to create per persona id, for example `{ member: 1 }` */
  documents?: Record<string, number>;
  name?: string;
}

/** A workspace as the control API created it. */
export class WorkspaceFixture {
  readonly id: number;
  readonly name: string;
  readonly status: 'ACTIVE' | 'DELETED';
  readonly joinUrl: string;
  /** handed out once at creation; a Secret, so it is masked in shots and scrubbed from evidence; never printed */
  readonly joinCode: SecretValue | null;
  readonly locked: boolean;
  readonly members: Array<{ persona: string; userId: string; role: MemberRole; state: MemberState }>;
  readonly invites: Invite[];
  readonly documents: DocumentRef[];

  constructor(
    raw: RawWorkspace,
    joinCode: SecretValue | null,
    webOrigin: string,
    personaIdOf: (handle: string) => string,
  ) {
    this.id = raw.id;
    this.name = raw.name;
    this.status = raw.status;
    this.joinUrl = raw.joinUrl;
    this.joinCode = joinCode;
    this.locked = raw.locked;
    this.members = raw.members.map((m) => ({
      persona: personaIdOf(m.handle),
      userId: m.userId,
      role: m.role,
      state: m.state,
    }));
    this.invites = raw.invites;
    this.documents = raw.documents.map((d) => ({
      id: d.id,
      title: d.title,
      uploadedBy: personaIdOf(d.uploadedBy),
      path: d.path,
      url: new URL(d.path, webOrigin).toString(),
      indexed: d.indexed,
    }));
  }

  /** The i-th document the fixture created (in the order of the spec's `documents`). */
  document(index = 0): DocumentRef {
    const doc = this.documents[index];
    if (!doc) throw new Error(`workspace ${this.id} has ${this.documents.length} document(s); no index ${index}`);
    return doc;
  }

  documentsBy(persona: string): DocumentRef[] {
    return this.documents.filter((d) => d.uploadedBy === persona);
  }

  member(persona: string): WorkspaceFixture['members'][number] {
    const member = this.members.find((m) => m.persona === persona);
    if (!member) throw new Error(`${persona} is not in workspace ${this.id}`);
    return member;
  }

  invite(email: string): Invite {
    const invite = this.invites.find((i) => i.email.toLowerCase() === email.toLowerCase());
    if (!invite) throw new Error(`workspace ${this.id} has no invite for ${email}`);
    return invite;
  }

  /** What a report or a log may show: never the code. */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      locked: this.locked,
      members: this.members,
      invites: this.invites.length,
      documents: this.documents.length,
    };
  }
}

export class DemoControl extends Control {
  #personaIdOf = (handle: string): string => {
    const dot = handle.indexOf('.');
    const ns = dot > 0 ? handle.slice(0, dot) : '';
    const id = dot > 0 ? handle.slice(dot + 1) : '';
    if (ns !== this.ns || !id) throw new Error(`the backend returned ${handle}, outside namespace ${this.ns}`);
    return id;
  };

  #fixture(raw: RawWorkspace): WorkspaceFixture {
    const code = raw.joinCode ? this.secret(raw.joinCode, `workspace ${raw.id} code`) : null;
    return new WorkspaceFixture(raw, code, this.webOrigin, this.#personaIdOf);
  }

  /** A workspace in one call: owner, members, guests, invites and documents. Tracked, so teardown deletes it. */
  async workspace(spec: WorkspaceSpec): Promise<WorkspaceFixture> {
    const people = [spec.owner, ...(spec.members ?? []), ...(spec.guests ?? []), ...Object.keys(spec.documents ?? {})];
    for (const id of people) this.persona(id); // unknown persona ids fail here, before any call
    // Marked before the call: if it fails half way, teardown still resets them.
    for (const id of people) this.touched.add(id);
    const { data } = await this.api.call<RawWorkspace>('createWorkspace', {
      body: {
        runId: this.runId,
        owner: this.handle(spec.owner),
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        members: (spec.members ?? []).map((id) => this.handle(id)),
        guests: (spec.guests ?? []).map((id) => this.handle(id)),
        invites: (spec.invites ?? []).map((i) => ({ email: this.address(i.to), state: i.state ?? 'PENDING' })),
        documents: Object.fromEntries(Object.entries(spec.documents ?? {}).map(([id, n]) => [this.handle(id), n])),
      },
    });
    this.track('workspace', String(data.id));
    return this.#fixture(data);
  }

  /** The server's current view of a workspace (members, invites, lock); never the code. */
  async refresh(ws: WorkspaceFixture | number): Promise<WorkspaceFixture> {
    const id = typeof ws === 'number' ? ws : ws.id;
    const { data } = await this.api.call<RawWorkspace>('getWorkspace', { params: { id } });
    return this.#fixture(data);
  }

  /** Delete a workspace; what teardown calls for every tracked one. Deleting twice, or one already gone, is fine. */
  async deleteWorkspace(ws: WorkspaceFixture | number | string): Promise<void> {
    const id = typeof ws === 'object' ? ws.id : ws;
    try {
      await this.api.call('deleteWorkspace', { params: { id } });
    } catch (error) {
      if (!(error as TestApiError).notFound) throw error;
    }
    this.untrack('workspace', String(id));
  }

  /** Lock the join link as five wrong codes would. */
  async lockLink(ws: WorkspaceFixture | number): Promise<void> {
    await this.api.call('lockLink', { params: { id: typeof ws === 'number' ? ws : ws.id } });
  }

  async expireInvite(invite: Invite | number): Promise<Invite> {
    const id = typeof invite === 'number' ? invite : invite.id;
    return (await this.api.call<Invite>('expireInvite', { params: { id } })).data;
  }

  /** Run a scheduled sweeper now, scoped to this run and this namespace. The demo has one: `invites`. */
  async runSweeper(name = 'invites'): Promise<{ changed: number; details: string[] }> {
    const { data } = await this.api.call<{ changed: number; details?: string[] }>('runSweeper', {
      params: { name },
      body: { runId: this.runId, namespace: this.ns },
    });
    return { changed: data.changed, details: data.details ?? [] };
  }
}

export default DemoControl;
