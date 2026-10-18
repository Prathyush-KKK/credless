# The credless framework: what a test can use

Import everything from `credless`: `import { about, expect, test } from 'credless';`. The helpers `typeSecret`,
`clearSecretField`, `see`, `notSee` and the `Secret` class come from the same entry. The names below are the kit's
public ones; an app adds its own on top (its control extension, its screen helpers), never in place of them.

## Fixtures

| Fixture | Scope | What it is |
|---|---|---|
| `personas` | test | signed-in browsers for personas, one context each, with the guard, the egress proxy and the evidence helpers |
| `control` | test | the test API behind one object: the core state methods plus the app's extension methods |
| `guard` | test | run-wide knobs applied to every session opened in this test (`expectStatus`, `expectSignal`, `allowConsole`) |
| `shot` | test | the fixture form of `session.shot()`, with this test's masks |
| `sensitive` | test | the codes in play in this test: masked in every shot and listed for the scrubber; rarely used directly |
| `kit` | worker | the run's config, this worker's namespace (`a0`), its test-API client and the ensured accounts; rarely needed |

## personas

```ts
const [owner, member] = await personas.open('owner', 'member'); // a typed tuple, in the order given
const visitor = await personas.openSignedOut('guest'); // a browser with no session: landing and sign-in screens
personas.persona('member'); // { id: 'member', ns: 'a0', handle: 'a0.member', email: 'qa+a0-member@example.com', displayName: 'Mika QA-a0', role, ... }
personas.address('ghost'); // 'qa+a0-ghost@example.com': a catalog address that is not an account
personas.sessions; // every session opened in this test
```

A persona opens once per test: the session provider mints one session per open, and a second one may end the
first. Names in a test are persona ids (`'owner'`); the fixtures map them to this worker's handles (`a0.owner`).

### `PersonaSession`

| Member | Use |
|---|---|
| `persona`, `id` | the resolved persona (`handle`, `email`, `displayName`, `role`, ...) and its catalog id |
| `page`, `context` | Playwright's page and browser context for this persona |
| `guard` | this persona's guard: the knobs above plus the lists it keeps (`violations`, `outside`, `thirdParty`, `devHosts`, `analyticsBlocked`, `apiErrors`, `cancelled`, `canarySeen`) |
| `goto(path)` | navigate on the web origin (`/`, `/w/12/members`); a path, never a full URL to another origin |
| `shot(step?, { mask?, fullPage?, triage? })` | screenshot of the current screen after the boot cover is gone, password fields, `[data-sensitive]`, the config's `maskSelectors` and every code in play masked; returns the path |
| `api(path, { method?, data?, headers? })` | the api origin as this persona, with the browser's cookies and the CSRF pair when the app has one; returns `{ http, data, signal }` and never throws on an error status; a redirect is returned, never followed; the api origin only |
| `a11y(step?)` | axe (WCAG 2.1 A and AA); findings are evidence, and failures only under `CREDLESS_A11Y=gate` |
| `aria(step?)` | writes `page.ariaSnapshot()` under `aria/` as agent-readable, scrubbable text; returns the path |
| `shots`, `a11yFindings`, `openedScreen` | what this session saved and saw; a passed test with `openedScreen` and no shot fails |

Every persona browser has its own egress proxy. Production and unlisted hosts are refused before any connection or
DNS lookup, including redirect hops and WebSockets that Playwright's routing never sees; private addresses are
refused on a remote target. A refusal fails the test with `egress proxy refused ...`, and a context whose traffic
did not go through its own proxy fails with `egress proxy bypassed`.

### The guard

The guard fails the test on: a console error, a page error, a failed request, an HTTP error status from the app or
the API, an unexpected sign-out (by default a 401 on the api origin), any request to production, and any request to a
host nobody listed (`hosts.thirdParty`, `hosts.analytics`; `hosts.outside: 'note'` lists instead of failing). It
lists, without failing: third-party hosts, other non-production hosts of the organisation, analytics it aborted,
API answers with an app-level error code, and requests a navigation cancelled. The lists are attached to the test
as `<persona>-<list>`.

```ts
guard.expectStatus(/\/api\/documents\/12$/, 404); // this test expects that status on matching URLs
guard.expectSignal(/\/api\/invites/, 4201); // an app-level error code (`signals.apiError`) this test expects
guard.allowConsole(/ResizeObserver loop/, 'browser noise on the members list'); // the reason is required
```

The `guard` fixture applies a knob to every session of the test; `session.guard` applies it to one persona.

## control

The core methods every app has (`StateControl`):

| Method | Use |
|---|---|
| `health()` | the test API's health: `environment`, `keyId`, `sinks`, `extensions` |
| `ensure(ids)` | the accounts for these persona ids exist in this namespace (the fixtures call it for you) |
| `reset(ids)` | the personas' server state back to the catalog's (teardown calls it for every persona touched) |
| `state(id)` | the backend's view of one persona: `{ handle, userId, state }` |
| `persona(id)`, `handle(id)`, `address(name)` | the resolved persona, its handle (`a0.owner`), an address in this namespace |
| `messages(to, query?)`, `waitForMessage(to, match, options?)` | what the mail sink captured for a persona or address, newest first; `codes` are `SecretValue`s |
| `teardown()` | remove everything created, then reset everything touched; returns the problems, never throws; the fixture calls it |
| `cleanupRun()` | the run-wide cleanup (every object tagged with the run id, every session minted under it); global teardown calls it |
| `touched`, `created`, `ns`, `runId` | what this instance will undo, and where it lives |

An app extends the class (plan "extension pattern") and tests call the extension's methods through the same
fixture, typed through `config.control.module`:

```ts
// e2e/control.ts in the app
import { Control } from 'credless/adapters';

export default class AppControl extends Control {
  async workspace(spec: { owner: string; members?: string[]; guests?: string[]; documents?: Record<string, number> }) {
    const { data } = await this.api.call<{ id: string; inviteCode?: string }>('createWorkspace', {
      body: this.handles(spec), // persona ids become this worker's handles
    });
    this.track('workspace', data.id); // teardown deletes it, even when the test failed
    const code = data.inviteCode ? this.secret(data.inviteCode, `workspace ${data.id} code`) : null; // masked + scrubbed
    return { id: data.id, code, path: `/w/${data.id}` };
  }
}
```

```ts
// in a test
const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } });
ws.id; ws.code; // code is a SecretValue: type it with typeSecret, never print it
await control.state('member'); // the server's view now
```

The protected surface an extension uses: `this.api.call(operationId, { params, query, body })` (the operation must
be in the app's contract file; the broker answers 404 to anything else), `this.track(kind, id)` and
`this.untrack(kind, id)` for teardown, `this.secret(value, label)` to wrap a value the backend handed out, and
`this.handles(spec)` to map persona ids to handles inside a request.

## Secrets on screen and in code

- A `SecretValue` (`Secret`) prints as `[redacted]` in `String()`, template literals, `JSON.stringify` and
  `util.inspect`; `reveal()` is for the one place that sends the value, and test code almost never needs it.
- A password or code goes into a field only with `typeSecret(field, secret)`, and the field is emptied with
  `clearSecretField(field)` in a `finally`. `fill()`, `type()` and `pressSequentially()` put the value in the step
  title, which the HTML report keeps.
- `see(locator, secret)` and `notSee(locator, secret)` assert on a secret's value and print only its label.
- Codes the test is given (`ws.code`, `message.codes[0]`) are masked in every screenshot, typed or shown, and
  scrubbed from traces, reports and logs.
- A code shown one digit per box (an OTP-style input) is not one text node, so the masks do not find it: mask the
  boxes yourself, `shot('code-entry', { mask: [page.locator('[data-otp-box]')] })`.
- `sensitive.add(secret)` registers a value that reached the test some other way (rare).

## Annotations

`about(source, expected)` at the top of each test writes the `source` and `expected` annotations that become the
Source and What-it-checks columns of `COVERAGE.md`. A test without it still runs, and shows up in the table as
unsourced.

## Personas and namespaces

The catalog (`personas.yaml`) says who the test accounts are and what each is for. It holds no secrets.

```yaml
version: 1
addressTemplate: qa+{ns}-{persona}@example.com
lastNameTemplate: QA-{ns}
defaults: { locale: en-US, timezone: UTC, auth: session }
personas:
  owner: { role: owner, firstName: Oona, purpose: owns a workspace; invites, removes, changes settings }
  member: { role: member, firstName: Mika, purpose: a member; the one who gets removed }
  guest: { role: guest, firstName: Gael, purpose: never in the workspace; must see nothing of it }
  second-owner: { role: owner, firstName: Saga, purpose: a second workspace, for isolation }
addresses:
  ghost: { template: qa+{ns}-ghost@example.com, purpose: an invited address nobody answers for }
```

A persona is a role; the runner creates one account per persona per namespace, `<slot letter><worker index>`.
Worker 0 of slot `a` uses `a0.owner` = `qa+a0-owner@example.com`, display name "Oona QA-a0". Two workers never share
an account, nor do two agents on different slots, so tests never collide. A persona with `auth: password` signs in
through the UI with a password the CLI hands to the one sign-in test as a file; every other persona gets a minted
session and has no password at all.

Changing the catalog is a product decision: propose it as a pull request with the reason. `credless check-tests`
and the catalog check refuse addresses outside `personas.addressPattern`, duplicate first names (screenshots must
tell people apart) and any field that looks like a password or token.

## Writing a screen helper

Keep them in your own module (for example `e2e/screens.ts`), one function per screen action: navigate by route,
wait for the screen's own ready state, act, and check that the step really happened before returning (`remove()`
waits until the member is gone from the list). Helpers take a `PersonaSession`, never a bare `Page`, so the guard
and the shots stay attached. Put the visible words the helpers look for in one module and import them.
