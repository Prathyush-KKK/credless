# Security

This file is the kit's security contract with its users: how to report a finding, what is in scope, the threat
model with the gaps we have not closed, the claims we make and the ones we do not, what the evidence contains and
how it is handled, and how to check which layers are active on a machine.

credless means the agent, the test code and the evidence run without the credential: no long-lived key, password or
service token is given to them; what they hold is a short-lived session for a synthetic account, and we say exactly
what that is.

> credless is not a security boundary. The boundaries are the broker process that holds the key and the test API's
> locks on your server; everything else in the kit (the guard, the egress proxy, the scrub, the deny rules, the
> lint gate) is defence in depth that an agent with shell access could in principle edit, which is why the
> self-tests check each layer and `credless doctor --security` tells you which ones are active on this machine.

## Reporting a finding

Report privately through
[GitHub Security Advisories](https://github.com/Prathyush-KKK/credless/security/advisories/new) ("Report a
vulnerability" on the repository's Security tab). Do not open a public issue, and do not paste a secret value, a
cookie or a code into the report; describe the shape and the artefact it appeared in.

- credless is maintained by one independent developer, so these are best-effort targets, not an SLA:
  acknowledgement within 3 business days; triage, a severity and a plan within 7.
- Coordinated disclosure within 90 days of the report, sooner when a fix ships sooner. We publish an advisory and a
  changelog line and credit the reporter by default (tell us if you would rather not be named).
- A bypass of a documented gap (see the threat model) is a documentation issue and welcome as a public issue. A
  bypass of a claimed property is a release the same week.
- There is no bug bounty. We say so plainly rather than imply one.

## Scope

In scope: the broker (`core/broker.ts`), the egress proxy and guard (`fixtures/egress.ts`, `fixtures/guard.ts`),
the evidence pipeline (scrub, scan, quarantine, fail-closed move), the key handover in the runner, the reference
test-API server (`credless/server`) and its locks, the built-in adapters, the GitHub Action, the Claude Code plugin's
hook, the `init` templates and the skill's instructions where they bear on secrets.

Out of scope: Playwright itself (report to Microsoft); the backend you implement from the brief, unless the fault is
in the brief or the reference server; the fact that an agent with shell access can edit the kit's code (by design;
the boundary is the broker and your server); findings that need the test API's flag on in production, which the
brief's locks forbid; the evidence you choose to keep or share after a run.

## Threat model

Numbers follow the research this kit was designed from (docs/research/04-security.md, §4). "v0.1" is what ships;
"gap" is what remains; "planned" names the version.

| # | Attack | Mitigation in v0.1 | Gap | Planned |
|---|---|---|---|---|
| T1 | Agent-written test code exfiltrates from the Node worker: `fetch()`, `node:net`, a fresh `chromium.launch()` without `proxy`, `request.newContext()`. | A test-code lint gate (`check-tests`, run by `check` and by the action) forbids browser launches, `newContext`, `proxy`, `launchOptions`, network and process modules, `process.env` and bare `fetch` in test dirs. An advisory worker shim (`--import`) routes Node's `fetch`, `http(s).globalAgent` and `net.Socket.connect` through a run-level proxy with the same policy; self-test N01 proves `fetch()` from a worker to the sentinel fails. The worker holds no key (B01). | In native mode the worker is not network-isolated: the shim can be bypassed by code that reaches below it. What the worker holds: the per-run broker token (loopback only), minted session cookies for synthetic accounts, the sign-in password file for the one UI sign-in test, synthetic data. | v0.2 `run --isolate` (docker mode): an internal network, a sidecar egress proxy, no other route; `doctor --security` reports `worker egress: isolated / not isolated`. |
| T2 | The agent reads the broker's memory (it lives in Playwright's main process; workers are its children). | Linux with Yama `ptrace_scope=1` blocks a child attaching to its parent; the plugin hook refuses `ps e`, `/proc/*/environ`, `docker inspect`, `docker exec`, `lldb`, `gdb`, `gcore`. | A debugger run by the same user on a host without Yama, or with an unhardened Node binary, can read the process. The hook is a backstop. | v0.2: the broker as its own process (own user in docker mode), key read there, non-dumpable, Unix socket in a 0700 dir. |
| T3 | Exfiltration through an allowed host: a third-party API that accepts any tenant id, a query string on a font host. | Allowlists are exact or `*.label.tld` globs; a rule that would match a production host is refused at load; analytics hosts are aborted; third-party traffic is listed per test. | A host allowlist cannot tell your project on a shared API from an attacker's. Blast radius: dev cookies and synthetic data. | Fulfil third-party hosts from a recorded cache in CI; per-test byte counts in `SUMMARY.md`. |
| T4 | DNS rebinding or a name that resolves to a private address: the proxy judges the name, then dials `127.0.0.1` (the broker port) or `169.254.169.254` on a CI runner. | Judge before DNS; resolve once with `dns.lookup(host, { all: true })`; refuse loopback, link-local, RFC 1918, CGNAT, `0/8` and their IPv4-mapped forms unless the target is `local`; dial the first address with the original Host and SNI and pin it; cap header bytes (16 KiB), tunnels (64) and idle time (60 s). Self-test G13 feeds a rebinding resolver. | None known beyond the general limits of an HTTP CONNECT proxy. | |
| T5 | Proxy bypass through browser options: `launchOptions.args` with `--proxy-server` or `--proxy-bypass-list`, `ignoreDefaultArgs`, `test.use({ proxy })`. | The worker fixture refuses to start when `project.use.proxy` is set or the launch args carry proxy or host-resolver flags; the lint gate bans the options in test dirs; a canary request per browser context must be answered by that context's own proxy or the test fails with "egress proxy bypassed" (G14). | A platform that silently ignores a per-context proxy makes every test on it fail loudly, which is the intended failure mode, not a pass. | |
| T6 | WebKit WebRTC sends UDP (STUN, TURN) around the HTTP proxy. | Chromium runs with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; self-test G12 counts datagrams at a UDP sentinel. | WebKit has no such switch; a page using `RTCPeerConnection` in WebKit can send UDP. | v0.2 `run --isolate` closes it for every engine (UDP has nowhere to go). |
| T7 | CI exposes the key. | The GitHub Action takes the key from an environment secret and passes it to the one `run` step only; the CLI takes it over from its environment, deletes it from its own environment and hands it to global setup as a 0600 file. `credless demo` needs no key at all. | An environment variable is masked in logs, not hidden: anyone who can edit the workflow of a protected environment can read it. Use an environment with required reviewers. | v0.3: OIDC key sources for GitHub and GitLab CI, so no static key variable exists. |
| T8 | Replay of minted cookies: a session cookie is in worker memory, in trace network headers and in `results.json`. | Cookies are host-only, `HttpOnly`, `Secure`, with the backend's TTL (the brief recommends at most one hour); every cookie value is scrubbed by value; `cleanupRun` revokes every session minted under the run id and global teardown calls it. | A copied cookie works until revocation or expiry, against a synthetic account on dev. No cookie binding exists in browsers. | v0.2 `SessionProvider.verify` and re-mint on expiry, so shorter TTLs are practical. |
| T9 | Test-account flag abuse: an attacker who can register an address inside the test range gets an account the test API can mint sessions for; a flagged account joins a real dev user's object. | The brief sets the flag only through `personas/ensure` and only for addresses matching the configured pattern; every route refuses an account without the flag; the brief forbids putting a non-test account into a test object. | A flag by address pattern is weaker than a flag by provenance; mutating routes are not scoped by slot and namespace at the broker. | Provenance-based flag (refuse `ensure` for a pre-existing account) and slot scoping in the brief and the reference server. |
| T10 | Rate-limit gaps: a valid key can hammer the test API; nothing throttles failed key attempts. | The brief asks for 120 sessions a minute per key (429 above it) and a constant-time compare with a long random key. | No throttle on 401s, no alert on a burst. | Per-IP 401 throttle and an audit alert in the brief. |
| T11 | Supply chain of the kit: npm dependencies, the Playwright image, the plugin marketplace. | Exact versions and a frozen lockfile; install scripts off for every dependency; `doctor` reports whether the Playwright image is pinned by digest; every release is cut by `pnpm release`, which refuses to publish unless `pnpm verify` passes, and `pnpm verify` installs the packed tarball into a blank project and drives it through npm's own bin link before anything is published; the marketplace pins a release tag, never `main`. | Releases are built on the maintainer's machine, so there is no npm provenance attestation; one maintainer reviews changes; no SBOM yet. To check a release, compare the published tarball (`npm pack credless@<version>`) with the tagged source. | v0.2 SBOM per release; provenance if the project moves to hosted CI. |
| T12 | Indirect prompt injection into the agent through evidence: trace DOM snapshots, console lines, mail bodies and aria snapshots are page text the agent reads later. | The skill frames evidence as data, never instructions; dev content is synthetic; the agent never browses live through the kit. | No mechanical defence exists; this can be bounded, not closed. | A shipped settings block for Claude Code that denies reads of the staging dir and key files. |
| T13 | The sign-in password is a secret test code can read (`CREDLESS_SIGNIN_PASSWORD_FILE` is in the worker environment for the one UI sign-in test). | The fixture reads the file once into a `Secret`, deletes it, and `typeSecret` enters it without a step title or trace action quoting it; the scrub catches the value in output; the lint gate forbids `fs` in test dirs. | It contradicts an absolute "never touches a secret" claim, which is why we do not make one. | Replace the password with a one-time sign-in token the broker fetches when the sign-in test starts. |

Production is refused four times on the client (the config loader, the guard, the egress proxy, and the broker which
forwards contract routes to the configured origin only) and should be a 404 at the backend's five locks (flag, boot
guard, key, test-account flag, ingress). The client-side locks are code an agent could edit; the backend's are the
boundary.

## Claims we make, and claims we do not

Safe to say, each true today and covered by a self-test:

- The agent and the test code never hold the test-API key. Only a loopback broker in the runner does, and a self-test
  (B01) proves the workers do not.
- The key is never in an environment variable, on a command line or in a container's configuration during a run; it
  moves as a 0600 file that global setup reads and deletes.
- Every persona browser runs behind its own egress proxy that refuses production and unlisted hosts before any
  connection or DNS lookup, including redirect hops and WebSockets; Chromium sends no WebRTC UDP.
- Evidence is scrubbed by value in four encodings, then scanned; anything still secret-shaped is deleted and listed;
  a leaked secret value fails the run; evidence that was not fully processed is deleted, never kept.
- Sessions are minted only for flagged synthetic test accounts, only on dev or staging, expire in at most one hour
  when the backend follows the brief, and every call is audited with the key id. Nobody signs in as a real person; no
  shared human credentials exist.
- Production is refused by four client-side locks and is a 404 at the backend's five locks once your backend
  implements the brief, ingress rule included.
- We publish our threat model and the gaps we have not closed.

Never said, in a README, a post, a talk or a reply:

- "The agent cannot exfiltrate anything" or "sandboxed end to end": the Node worker is not isolated in native mode,
  and the kit is not an OS sandbox.
- "Secrets never touch the agent" as an absolute: the broker token, minted cookies and the sign-in password are in
  the worker. We say "the long-lived credential".
- "Prevents prompt injection": we bound the blast radius. "Impossible to run against prod": refused by code the agent
  could edit; the boundary is the backend.
- "SOC 2 compliant", "ISO 27001 certified"; "screenshots contain no secrets or PII" (regexes cannot read images);
  "no secrets in CI" until OIDC lands.
- Anything that reads as 1Password, Anthropic, Microsoft, GitHub or OWASP endorsing the kit; "safe" without its limits
  beside it; "zero trust"; "military-grade".

## Data classes in the evidence

| Class | Where it can appear | Handling |
|---|---|---|
| Test-API runner key | nowhere in the evidence | Read by the CLI, handed over as a 0600 file, held by the broker; never in a worker, a browser, argv, a container config or a file that is kept. The scan knows its value and fails the run if it ever appears. |
| Per-run broker token | worker environment, broker logs | Loopback only, worthless after the run; scrubbed by value. |
| Minted session cookies | worker memory, trace network headers, `results.json`, storage state | Host-only, `HttpOnly`, `Secure`; every cookie value is collected and scrubbed; the scan fails the run on a surviving value; revoked by `cleanupRun`. |
| One-time codes (invites, sign-in) | screens, mail bodies, test-API answers | Wrapped as `Secret` on arrival; masked in every screenshot by selector and by an HMAC list the fixtures keep (`.sensitive-hashes`, deleted before the evidence is kept); scrubbed by value; never printed. |
| Sign-in password (one persona) | the 0600 file, the sign-in test's memory | Read once and deleted; entered with `typeSecret`; the field is cleared before any later snapshot; scrubbed by value. |
| Persona identities | everywhere | Synthetic by construction: generated names, addresses inside the configured test range. No real person's data. |
| Application content | screenshots, traces, aria snapshots | Synthetic when it comes from the test API. If your dev environment holds real users' data, that data is yours to keep out of test objects; the brief refuses non-test accounts in test objects for that reason. |
| Screenshots | `shots/`, `contact-sheets/` | Password fields, `[data-sensitive]`, `evidence.maskSelectors` and every code in play are masked in `#FF00FF`. The scan cannot read text inside an image; an unmasked secret shown as plain text on a screen is not caught. |
| Traces | `artifacts/<test>/trace.zip` | No screencast frames; `retain-on-failure` by default; Playwright 1.65's `trace.secrets` when available; scrubbed inside the zip, nested zips included. |
| HTML report, JUnit, CTRF, blob | `html/`, `junit.xml`, `ctrf.json`, `blob/report.zip` | Scrubbed, including the base64 zip embedded in the HTML report (self-test E09). |
| Console and network logs, `error-context.md`, aria snapshots | `artifacts/`, `aria/` | Scrubbed text. Treat as untrusted when an agent reads it (T12). |
| `scan.json`, `QUARANTINED.md`, `SUMMARY.md` | the kept folder | Name the file and the kind of finding, never a value. |

Retention is yours: the GitHub Action keeps the reports artifact for 14 days by default and anyone with read access to
the repository can download it; `reports/` on a machine is yours to clean.

## Compliance

credless supports controls your auditors ask about; it does not make anything compliant. It supports SOC 2 CC6.1
(least privilege: one scoped key, test accounts only, no shared human logins), CC6.2 (credential issuance tied to an
identity), CC6.3 (role and namespace scoping), CC6.6 (boundary protection: egress allowlist, prod refusal), CC6.7
(restricted transmission: the key never leaves the broker, evidence is scrubbed), CC7.2 (an audit line per call; the
leak check fails the run) and CC8.1 (locks tested in the build). Against ISO/IEC 27001:2022 Annex A it supports
5.15–5.18 (access control and identity), 8.2, 8.3, 8.5, 8.11 (data masking), 8.12 (data leakage prevention), 8.15,
8.16, 8.28, 8.29, 8.31 (separation of development, test and production) and 8.33 (test information: synthetic
personas, no real PII). The evidence for each is the self-test that exercises it; the gaps are in the threat model.

## `credless doctor --security`

```sh
npx credless doctor --security            # this machine
npx credless doctor --security --target dev
```

`doctor` reads no secret: a key source is reported by presence (through its `describe()`), never by reading it.
Without `--security` it checks tools, Node, Docker, browsers, the slot, the staging dir's permissions (advisory on
Windows, and it says so), the key source by presence, and probes the target without a key (a 401 means the test API
is present and locked; a 404 means it is not deployed there; an answer without a key means a lock is broken and it
says so in red). `--security` adds one `on` or `off` line per layer:

| Line | Meaning |
|---|---|
| broker | the runner key stays in Playwright's main process; workers hold a per-run token (inside the test process tree until v0.2) |
| egress proxy per browser context | judged by host before DNS; private ranges refused on remote targets |
| canary | every context must reach `canary.credless.invalid` through its own proxy, or its test fails |
| lint gate | `check-tests` forbids browser launch, contexts, proxy options, network, process and fs in test dirs |
| worker shim (advisory) | workers dial loopback only; bypassable by code that reaches `process.binding` |
| evidence | scrub by value in four encodings, scan, quarantine, marker; anything unfinished is deleted |
| trace secrets | `on` with Playwright 1.65 or later (known secrets render as `<secret>` in traces); `off` below it, and the scrub covers it |
| docker isolate | `off` in v0.1 (`run --isolate` lands in v0.2) |

Paste this output into a bug report; it carries no secret.

## The leak-vector suite

The self-tests that back the claims above, by id: B01–B03 (the broker and the workers' environment), G01–G14 (the
guard and the egress proxy, including G13 rebinding and G14 canary), P01–P08 (personas), E01–E09 (the evidence
pipeline, E09 against a real HTML report), R01–R06 (the verdict and fail-closed deletion), N01 (the worker shim),
Q02–Q03 (slot and doctor). A published conformance suite covering traces, HAR, the HTML report's base64 zips, aria
snapshots, console, step titles, CTRF and JUnit is planned; until it exists, the self-tests above are the
evidence, and `credless demo --plant-secret` lets anyone watch a planted value fail a run. If you can get a secret
value past the pipeline, we want the report.
