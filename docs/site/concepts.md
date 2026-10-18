# Concepts: personas, the test API, the key broker, the egress guard and evidence

## Personas

A persona is a role, not an account: `owner`, `member`, `guest`, `second-owner`, `signin`. The catalog
(`personas.yaml`) gives each one a role the app's test API interprets, a unique first name so screenshots tell people
apart, a purpose, optional attributes (a plan, flags) and an auth mode: `session` (the default, minted server-side)
or `password` (one persona that signs in through the UI, for the sign-in screen test). A catalog can also name
addresses that are deliberately not accounts (`ghost`, for "invite someone who never answers").

Persona ids match `^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$`.

## Namespaces and slots

The kit creates **one real account per persona per namespace**. A namespace is a slot letter plus the worker's
parallel index: `a0`, `a1`, `b0`. The account handle the test API knows is `<namespace>.<persona>` (`a0.owner`), and
its address is the catalog's template rendered into the configured range (`qa+a0-owner@example.com`).

The **slot** is one lowercase letter per machine or agent, set once with `credless slot <letter>` (or
`CREDLESS_SLOT`, or `--slot` for one run; CI uses `z`). A local target uses `a` when none is set; a remote target
is refused until the machine has one.
Two people, or a person and an agent, on different slots never share an account; two workers in one run never share
one either. A lock per target and slot (`mkdir` in the staging dir, owner pid inside) stops two runs on the same
slot from racing each other.

Why namespaces and not Playwright's test locks: locks serialise; namespaces keep true parallelism, which is what
multi-user tests need (three browsers in one test, four workers at once). Document `lock` for singleton resources
the persona model cannot partition.

## The test API

Seven routes on your backend, under `/_test` on the API origin, dev and staging only, behind five locks (flag off
by default with the routes absent; boot guard refusing production and staging; constant-time key compare with
rotation; test-account flag plus address pattern; 404 at the ingress outside dev). They ensure and reset personas,
answer their state, **mint a real session through the app's own login seam** (the same cookies a web login sets,
at most one hour, tagged with the run id), expose captured mail with links and codes parsed out, and clean up a run.
An app adds its own routes under the same base path (the extension pattern) for one-call scenarios like "a workspace
with this owner, these members and this many documents".

The contract is [`contract/core.openapi.yaml`](../../contract/core.openapi.yaml); the brief for the backend team is
[`contract/BACKEND-BRIEF.md`](../../contract/BACKEND-BRIEF.md); `credless/server` is a reference implementation for
Node backends; the demo app runs it.

## The broker

The runner key (the test API's `X-Test-Runner-Key`) is the long-lived credential, and it never reaches the test.
Where it is, moment by moment: in its source (an environment variable of the CLI process, a file, a CLI such as
`op`, the OS keyring); in one unexported variable of the CLI process, which deletes it from its own environment; in
a 0600 file in the 0700 staging dir for the seconds between spawn and global setup; in the memory of the **broker**,
a loopback HTTP server global setup starts in Playwright's main process, until teardown. Never a worker's
environment, a browser, a container config, argv or the evidence.

Workers get `CREDLESS_BROKER_URL` and a per-run `CREDLESS_BROKER_TOKEN` (worthless after the run). The broker
forwards contract routes only (core plus the app's extension routes), never follows redirects, forwards only listed
request headers, and returns status, body and `Set-Cookie`. Self-test B01 reads every worker's environment and
proves the key is not there.

## The egress guard

Every persona browser is its own context with its own **egress proxy** on loopback. The proxy judges host and
port **before any DNS lookup**: `prod` (refused, violation), `canary` (answered by the proxy itself), `own` (pass),
`analytics` (aborted, listed), `third-party` and `dev` (pass on 80/443, listed), `outside` (refused). After the
verdict it resolves once, refuses private and loopback addresses on a remote target, and dials the first address
with the original Host and SNI pinned for the connection. Because it sits below Playwright's routing it sees what
`page.route` never does: redirect hops, WebSocket handshakes, `context.request` calls. Chromium runs with
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` so no UDP goes around it; WebKit has no such switch
(a documented gap until `run --isolate`).

A **canary** request per context (`http://canary.credless.invalid/`) must be answered by that context's own proxy,
or the test fails with "egress proxy bypassed". The worker fixture also refuses to start when `project.use.proxy` is
set or the launch args carry proxy flags, and the lint gate (`check-tests`) keeps `chromium.launch`, `newContext`,
`proxy`, `launchOptions`, network and process modules and bare `fetch` out of test code.

The **guard** on top of the proxy fails a test on a console error, a page error, a failed request, an HTTP error
from the app or the API, an unexpected sign-out and any violation; it lists third-party, dev and analytics traffic
as attachments. A test that expects an error says so with a reason: `guard.expectStatus(/\/api\/documents\/12$/, 404)`.

## Evidence

Evidence is written to a private **staging** folder (0700, per user) during the run. After the run, post-run
**scrubs** by value in four encodings (raw, URL-encoded, base64, JSON-escaped), inside zips, nested zips and the
base64 zip embedded in the HTML report; then **scans** (read-only; it lists file and kind, never a value); then
**quarantines** any file where a finding survived; then writes the contact sheets, `COVERAGE.md`, `FLAKES.md`
(`--twice`), `SUMMARY.md` and a marker; then moves the folder to `reports/<run id>/`. A secret value found anywhere
fails the run (exit 1). Anything that stops the pipeline before the marker (exit 4, a crash, a kill) deletes the
staging folder: evidence is kept only when it was fully processed.

Upstream of the pipeline: sessions come from the test API (no passwords typed except the one sign-in test, with
`typeSecret`, never `fill`), screenshots mask password fields, `[data-sensitive]`, `evidence.maskSelectors` and every
code in play, traces carry no screencast frames, and Playwright 1.65's `trace.secrets` is set for values known at
config time when the installed Playwright supports it. Known limit: the scan cannot read text inside an image.

[Evidence](evidence.md) has the folder layout and how to read it.
