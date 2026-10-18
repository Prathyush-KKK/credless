// The demo backend's state: users, workspaces, documents, invites, sessions and the sinks. In memory, loopback only.
//
// It is a small "documents for teams" app with the rules the kit's self-tests and the quickstart suite exercise: an
// ACTIVE member sees the workspace's documents, a removed member does not; joining takes the link and a six-digit
// code and five wrong codes lock the link; a login ends the account's other sessions; everything a run creates is
// tagged with the run id so `cleanupRun` can remove it. Nothing here is a real backend.
import crypto from 'node:crypto';
import type {
  MailQuery,
  PersonaRef,
  PersonaSpec,
  PersonaState,
  ResetResult,
  WireMessage,
} from '../../../packages/kit/src/types.ts';

export interface User {
  id: string;
  handle: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  role: string;
  /** `password` accounts sign in through the UI with the stand-in password; `session` accounts only through the test API */
  auth: 'session' | 'password';
  attributes: Record<string, unknown>;
  /** the attributes at `ensure`, restored by `reset` */
  baseline: { displayName: string; firstName: string; lastName: string; attributes: Record<string, unknown> };
  /** lock 4 of the backend brief: the test API refuses every account without this flag */
  isTestAccount: boolean;
}

export type MemberRole = 'owner' | 'member' | 'guest';
export type MemberState = 'ACTIVE' | 'REMOVED' | 'LEFT';
export interface Member {
  handle: string;
  role: MemberRole;
  state: MemberState;
}

export type InviteState = 'PENDING' | 'JOINED' | 'EXPIRED' | 'LOCKED';
export interface Invite {
  id: number;
  email: string;
  state: InviteState;
  /** epoch seconds */
  expiresAt: number;
}

export interface Workspace {
  id: number;
  name: string;
  runId: string;
  status: 'ACTIVE' | 'DELETED';
  joinToken: string;
  joinCode: string;
  wrongCodes: number;
  locked: boolean;
  members: Member[];
  invites: Invite[];
}

export interface Doc {
  id: number;
  title: string;
  /** handle of the uploader */
  uploadedBy: string;
  workspaceId: number;
  runId: string;
  indexed: boolean;
  deleted: boolean;
}

export interface Session {
  sid: string;
  csrf: string;
  handle: string;
  /** the run that minted it through the test API; null for a UI login */
  runId: string | null;
  /** epoch seconds */
  expiresAt: number;
}

export interface MailMessage extends WireMessage {
  body: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  /** epoch seconds */
  createdAt: number;
  read: boolean;
}

export interface WorkspaceSpec {
  runId: string;
  owner: string;
  name?: string;
  members?: string[];
  guests?: string[];
  invites?: Array<{ email: string; state?: 'PENDING' | 'EXPIRED' | 'LOCKED' }>;
  /** documents to create per uploader handle (the owner included) */
  documents?: Record<string, number>;
}

export type JoinResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: 'locked' | 'wrong-code' | 'already-member'; triesLeft: number };

export const SESSION_TTL_SECONDS = 3600;
export const MAX_WRONG_CODES = 5;
const INVITE_TTL_SECONDS = 7 * 86400;

export const now = (): number => Math.floor(Date.now() / 1000);
let seq = 1000;
const nextId = (): number => ++seq;
const token = (bytes: number): string => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string equality, for the stand-in password; the key check lives in the kit's handler. */
export function sameSecret(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

export class DemoState {
  readonly users = new Map<string, User>();
  readonly sessions = new Map<string, Session>();
  readonly workspaces = new Map<number, Workspace>();
  readonly docs = new Map<number, Doc>();
  /** captured mail by lowercase address; nothing is ever sent */
  readonly mail = new Map<string, MailMessage[]>();
  readonly notifications = new Map<string, Notification[]>();
  /** one line per notable event, read by `/__demo/state`; never a cookie or a code */
  readonly audit: string[] = [];
  /** the web origin join links point at; the server sets it once its port is known */
  webOrigin: string;
  readonly #signinPassword: string;

  constructor(options: { webOrigin: string; signinPassword: string }) {
    this.webOrigin = options.webOrigin;
    this.#signinPassword = options.signinPassword;
    // A real person's account: the test API must refuse it (403), whatever the key.
    const real: User = {
      id: 'u_real',
      handle: 'a9.real',
      email: 'someone@example.net',
      firstName: 'Real',
      lastName: 'Person',
      displayName: 'Real Person',
      role: 'member',
      auth: 'session',
      attributes: {},
      baseline: { displayName: 'Real Person', firstName: 'Real', lastName: 'Person', attributes: {} },
      isTestAccount: false,
    };
    this.users.set(real.handle, real);
  }

  log(line: string): void {
    this.audit.push(line);
    if (this.audit.length > 200) this.audit.shift();
  }

  // ---- users and sessions ---------------------------------------------------------------------------------------

  user(handle: string): User | undefined {
    return this.users.get(handle);
  }

  userByEmail(email: string): User | undefined {
    const wanted = email.toLowerCase();
    for (const u of this.users.values()) if (u.email.toLowerCase() === wanted) return u;
    return undefined;
  }

  userById(id: string): User | undefined {
    for (const u of this.users.values()) if (u.id === id) return u;
    return undefined;
  }

  /** `ensurePersonas`: create the account or leave it as it is. New accounts are flagged, verified and complete. */
  ensure(spec: PersonaSpec): PersonaRef {
    const existing = this.users.get(spec.handle);
    if (existing) return { handle: existing.handle, userId: existing.id, created: false };
    const a = spec.attributes;
    const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
    const [first = '', ...rest] = spec.displayName.split(' ');
    const user: User = {
      id: `u_${crypto.randomBytes(4).toString('hex')}`,
      handle: spec.handle,
      email: spec.email,
      firstName: str(a.firstName, first),
      lastName: str(a.lastName, rest.join(' ')),
      displayName: spec.displayName,
      role: str(a.role, 'member'),
      auth: a.auth === 'password' ? 'password' : 'session',
      attributes: { ...a },
      baseline: {
        displayName: spec.displayName,
        firstName: str(a.firstName, first),
        lastName: str(a.lastName, rest.join(' ')),
        attributes: { ...a },
      },
      isTestAccount: true,
    };
    this.users.set(user.handle, user);
    this.log(`ensure ${user.handle} created`);
    return { handle: user.handle, userId: user.id, created: true };
  }

  /** The server's view of one account: live memberships and unread notifications. */
  state(handle: string): PersonaState | null {
    const user = this.users.get(handle);
    if (!user) return null;
    const workspaces = [...this.workspaces.values()]
      .filter((w) => w.status === 'ACTIVE')
      .flatMap((w) =>
        w.members.filter((m) => m.handle === handle && m.state === 'ACTIVE').map((m) => ({ id: w.id, role: m.role })),
      );
    const live = [...this.sessions.values()].filter((s) => s.handle === handle && s.expiresAt > now()).length;
    return {
      handle,
      userId: user.id,
      state: {
        role: user.role,
        auth: user.auth,
        workspaces,
        sessions: live,
        notifications: (this.notifications.get(handle) ?? []).map((n) => ({
          type: n.type,
          title: n.title,
          createdAt: n.createdAt,
        })),
      },
    };
  }

  /** Mint a session the way a login does: the account's other sessions end (one device at a time). */
  mint(handle: string, runId: string | null): Session {
    for (const [sid, s] of this.sessions) if (s.handle === handle) this.sessions.delete(sid);
    const session: Session = { sid: token(24), csrf: token(16), handle, runId, expiresAt: now() + SESSION_TTL_SECONDS };
    this.sessions.set(session.sid, session);
    return session;
  }

  /** The user a session cookie belongs to, if the session is still live. */
  whoami(sid: string | undefined): { user: User; session: Session } | null {
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session || session.expiresAt <= now()) return null;
    const user = this.users.get(session.handle);
    return user ? { user, session } : null;
  }

  /** The UI sign-in: a flagged `password` account and the stand-in password; nothing else can sign in this way. */
  login(email: string, password: string): Session | null {
    const user = this.userByEmail(email);
    const ok = Boolean(user?.isTestAccount && user.auth === 'password') && sameSecret(password, this.#signinPassword);
    this.log(`login ${user?.handle ?? 'unknown'} ${ok ? 'ok' : 'refused'}`);
    return ok && user ? this.mint(user.handle, null) : null;
  }

  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  /** Revoke every session the test API minted under a run. */
  revoke(runId: string): number {
    let n = 0;
    for (const [sid, s] of this.sessions) {
      if (s.runId === runId) {
        this.sessions.delete(sid);
        n += 1;
      }
    }
    return n;
  }

  // ---- workspaces -----------------------------------------------------------------------------------------------

  workspace(id: number): Workspace | undefined {
    return this.workspaces.get(id);
  }

  workspaceByToken(joinToken: string): Workspace | undefined {
    for (const w of this.workspaces.values()) if (w.joinToken === joinToken && w.status === 'ACTIVE') return w;
    return undefined;
  }

  owner(w: Workspace): User {
    const member = w.members.find((m) => m.role === 'owner');
    const user = member ? this.users.get(member.handle) : undefined;
    if (!user) throw new Error(`workspace ${w.id} has no owner`);
    return user;
  }

  membership(w: Workspace, handle: string): Member | undefined {
    return w.status === 'ACTIVE' ? w.members.find((m) => m.handle === handle && m.state === 'ACTIVE') : undefined;
  }

  /** Live workspaces this handle is an active member of, the owner's first. */
  workspacesOf(handle: string): Array<{ workspace: Workspace; member: Member }> {
    const out: Array<{ workspace: Workspace; member: Member }> = [];
    for (const workspace of this.workspaces.values()) {
      const member = this.membership(workspace, handle);
      if (member) out.push({ workspace, member });
    }
    return out.sort((a, b) => (a.member.role === 'owner' ? -1 : 0) - (b.member.role === 'owner' ? -1 : 0));
  }

  canSee(handle: string, doc: Doc): boolean {
    if (doc.deleted) return false;
    const w = this.workspaces.get(doc.workspaceId);
    return Boolean(w && this.membership(w, handle));
  }

  /** A workspace in one call: owner, members, guests, invites (with their mail) and documents. */
  createWorkspace(spec: WorkspaceSpec): Workspace {
    const id = nextId();
    const short = spec.runId.slice(-4);
    const who = (handle: string) => handle.split('.')[1] ?? handle;
    const owner = this.users.get(spec.owner);
    if (!owner) throw new Error(`no user ${spec.owner}`);
    const w: Workspace = {
      id,
      name: spec.name ?? `Team ${who(spec.owner)} ${short}`,
      runId: spec.runId,
      status: 'ACTIVE',
      joinToken: token(16),
      joinCode: String(crypto.randomInt(100000, 1000000)),
      wrongCodes: 0,
      locked: false,
      members: [
        { handle: spec.owner, role: 'owner', state: 'ACTIVE' },
        ...(spec.members ?? []).map((handle): Member => ({ handle, role: 'member', state: 'ACTIVE' })),
        ...(spec.guests ?? []).map((handle): Member => ({ handle, role: 'guest', state: 'ACTIVE' })),
      ],
      invites: [],
    };
    this.workspaces.set(id, w);
    for (const invite of spec.invites ?? []) this.invite(w, invite.email, invite.state ?? 'PENDING');
    for (const [handle, count] of Object.entries(spec.documents ?? {})) {
      for (let i = 1; i <= count; i += 1) {
        const docId = nextId();
        this.docs.set(docId, {
          id: docId,
          title: `Doc ${short}-${id} ${who(handle)}-${i}`,
          uploadedBy: handle,
          workspaceId: id,
          runId: spec.runId,
          indexed: true,
          deleted: false,
        });
      }
    }
    this.log(`workspace ${id} created by ${spec.owner} run ${spec.runId}`);
    return w;
  }

  /** Add an invite and, when it is pending, capture the mail the app would send (link and code). */
  invite(w: Workspace, email: string, state: 'PENDING' | 'EXPIRED' | 'LOCKED' = 'PENDING'): Invite {
    const row: Invite = {
      id: nextId(),
      email,
      state,
      expiresAt: state === 'EXPIRED' ? now() - 60 : now() + INVITE_TTL_SECONDS,
    };
    w.invites.push(row);
    if (state === 'PENDING') {
      const owner = this.owner(w);
      const link = this.joinUrl(w);
      this.sendMail(email, {
        kind: 'invite',
        subject: `${owner.firstName} invited you to ${w.name}`,
        body: `${owner.displayName} invited you to the workspace ${w.name}.\nOpen ${link} and enter the code ${w.joinCode}.`,
        links: [link],
        codes: [w.joinCode],
      });
    }
    return row;
  }

  joinUrl(w: Workspace): string {
    return `${this.webOrigin}/j/${w.joinToken}`;
  }

  /** Join by link and code: the lock after five wrong codes, then the right code is refused too. */
  join(w: Workspace, handle: string, code: string): JoinResult {
    if (w.locked) return { ok: false, reason: 'locked', triesLeft: 0 };
    if (this.membership(w, handle))
      return { ok: false, reason: 'already-member', triesLeft: MAX_WRONG_CODES - w.wrongCodes };
    if (!sameSecret(code, w.joinCode)) {
      w.wrongCodes += 1;
      if (w.wrongCodes >= MAX_WRONG_CODES) {
        this.lock(w);
        return { ok: false, reason: 'locked', triesLeft: 0 };
      }
      return { ok: false, reason: 'wrong-code', triesLeft: MAX_WRONG_CODES - w.wrongCodes };
    }
    const previous = w.members.find((m) => m.handle === handle);
    if (previous) previous.state = 'ACTIVE';
    else w.members.push({ handle, role: 'member', state: 'ACTIVE' });
    const user = this.users.get(handle);
    for (const invite of w.invites) {
      if (invite.state === 'PENDING' && user && invite.email.toLowerCase() === user.email.toLowerCase())
        invite.state = 'JOINED';
    }
    this.log(`join ${handle} workspace ${w.id}`);
    return { ok: true, workspace: w };
  }

  lock(w: Workspace): void {
    w.locked = true;
    for (const invite of w.invites) if (invite.state === 'PENDING') invite.state = 'LOCKED';
    this.notify(
      this.owner(w).handle,
      'workspace.join.locked',
      `Joining ${w.name} is locked after too many wrong codes`,
    );
    this.log(`workspace ${w.id} locked`);
  }

  removeMember(w: Workspace, handle: string): boolean {
    const member = this.membership(w, handle);
    if (!member || member.role === 'owner') return false;
    member.state = 'REMOVED';
    this.notify(handle, 'workspace.removed', `You were removed from ${w.name}`);
    this.log(`workspace ${w.id} removed ${handle}`);
    return true;
  }

  deleteWorkspace(w: Workspace): void {
    if (w.status === 'DELETED') return;
    w.status = 'DELETED';
    for (const m of w.members) if (m.state === 'ACTIVE') m.state = 'LEFT';
    for (const d of this.docs.values()) if (d.workspaceId === w.id) d.deleted = true;
    this.log(`workspace ${w.id} deleted`);
  }

  documentsIn(w: Workspace): Doc[] {
    return [...this.docs.values()].filter((d) => d.workspaceId === w.id && !d.deleted);
  }

  search(handle: string, q: string): Doc[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return [...this.docs.values()].filter((d) => d.title.toLowerCase().includes(needle) && this.canSee(handle, d));
  }

  /** The test API's view of a workspace. The code is added by the create route only, once. */
  workspaceView(w: Workspace): Record<string, unknown> {
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      joinUrl: this.joinUrl(w),
      locked: w.locked,
      members: w.members.map((m) => ({
        handle: m.handle,
        userId: this.users.get(m.handle)?.id ?? '',
        role: m.role,
        state: m.state,
      })),
      invites: w.invites.map((i) => ({ ...i })),
      documents: this.documentsIn(w).map((d) => this.docView(d)),
    };
  }

  docView(d: Doc): Record<string, unknown> {
    return {
      id: d.id,
      title: d.title,
      uploadedBy: d.uploadedBy,
      workspaceId: d.workspaceId,
      path: `/d/${d.id}`,
      indexed: d.indexed,
    };
  }

  // ---- sinks ----------------------------------------------------------------------------------------------------

  sendMail(to: string, message: Pick<MailMessage, 'kind' | 'subject' | 'body' | 'links' | 'codes'>): void {
    const key = to.toLowerCase();
    const list = this.mail.get(key) ?? [];
    list.unshift({ ...message, id: `m${nextId()}`, to, sentAt: now() });
    this.mail.set(key, list);
  }

  /** Mail for a handle, newest first, as the contract's `Message` (no body: links and codes are parsed out). */
  listMail(handle: string, query: MailQuery): WireMessage[] {
    const user = this.users.get(handle);
    const list = user ? (this.mail.get(user.email.toLowerCase()) ?? []) : [];
    return list
      .filter(
        (m) =>
          (query.kind === undefined || m.kind === query.kind) && (query.since === undefined || m.sentAt >= query.since),
      )
      .slice(0, query.limit ?? 10)
      .map(({ body: _body, ...wire }) => wire);
  }

  notify(handle: string, type: string, title: string): void {
    const list = this.notifications.get(handle) ?? [];
    list.unshift({ id: nextId(), type, title, createdAt: now(), read: false });
    this.notifications.set(handle, list);
  }

  // ---- reset, sweepers, cleanup ---------------------------------------------------------------------------------

  /** `resetPersonas`: leave or delete what the account is in, clear its sinks, restore the baseline attributes. */
  reset(handle: string): ResetResult {
    let workspaces = 0;
    let documents = 0;
    for (const workspace of this.workspaces.values()) {
      const member = this.membership(workspace, handle);
      if (!member) continue;
      workspaces += 1;
      if (member.role === 'owner') this.deleteWorkspace(workspace);
      else member.state = 'LEFT';
    }
    for (const doc of this.docs.values()) {
      if (doc.uploadedBy === handle && !doc.deleted) {
        doc.deleted = true;
        documents += 1;
      }
    }
    for (const [sid, s] of this.sessions) if (s.handle === handle) this.sessions.delete(sid);
    const user = this.users.get(handle);
    if (user) {
      this.mail.delete(user.email.toLowerCase());
      this.notifications.delete(handle);
      Object.assign(user, { ...user.baseline, attributes: { ...user.baseline.attributes } });
    }
    return { handle, removed: { workspaces, documents } };
  }

  /** The invite sweeper, scoped to one run and one namespace: pending invites past their expiry become EXPIRED. */
  sweepInvites(runId: string, ns: string): string[] {
    const changed: string[] = [];
    for (const w of this.workspaces.values()) {
      if (w.runId !== runId || !this.owner(w).handle.startsWith(`${ns}.`)) continue;
      for (const invite of w.invites) {
        if (invite.state === 'PENDING' && invite.expiresAt <= now()) {
          invite.state = 'EXPIRED';
          changed.push(`invite ${invite.id} EXPIRED`);
        }
      }
    }
    return changed;
  }

  /** `cleanupRun`: delete every workspace and document tagged with the run. Sessions are revoked separately. */
  cleanupRun(runId: string): Record<string, number> {
    let workspaces = 0;
    let documents = 0;
    for (const w of this.workspaces.values()) {
      if (w.runId === runId && w.status === 'ACTIVE') {
        workspaces += 1;
        for (const d of this.documentsIn(w)) {
          d.deleted = true;
          documents += 1;
        }
        this.deleteWorkspace(w);
      }
    }
    for (const d of this.docs.values()) {
      if (d.runId === runId && !d.deleted) {
        d.deleted = true;
        documents += 1;
      }
    }
    return { workspaces, documents };
  }

  /** Introspection for the self-tests (`/__demo/state`): counts and the audit tail, never a cookie or a code. */
  introspect(): Record<string, unknown> {
    const sessions: Record<string, number> = {};
    for (const s of this.sessions.values()) sessions[s.handle] = (sessions[s.handle] ?? 0) + 1;
    return {
      users: [...this.users.values()].filter((u) => u.isTestAccount).length,
      workspaces: [...this.workspaces.values()]
        .filter((w) => w.status === 'ACTIVE')
        .map((w) => ({ id: w.id, runId: w.runId, locked: w.locked, members: w.members.map((m) => ({ ...m })) })),
      documents: [...this.docs.values()].filter((d) => !d.deleted).length,
      sessions,
      audit: this.audit.slice(-20),
    };
  }
}
