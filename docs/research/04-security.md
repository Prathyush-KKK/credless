# 04. Security research: "agents run signed-in E2E tests without ever touching a secret"

> **Dated working document.** This is a copy of a research report written on 18 Oct 2026, before the first line of
> credless was written, kept here because the README, SECURITY.md and the roadmap cite it. It is not maintained:
> versions, star counts, prices and issue states are as they were on that day, and marks such as "unverified" or
> "2nd-hand" are the author's at the time. References to the private predecessor (the internal framework this kit
> was generalised from) were replaced by that phrase and its internal names by generic ones; nothing else was edited.

Date: 2026-10-18. Scope: how the market isolates coding agents from secrets, what mature teams do about
test-login endpoints and evidence hygiene, a sceptical threat model of *our* design (the runner, broker, egress
proxy, guard, evidence pipeline, the five backend locks), and what we may and may not say about it.

Method note. Search excerpts were used for every item; primary pages were fetched where this sandbox's proxy
allowed it (the Claude Code sandboxing and cloud-environment docs, Anthropic's sandboxing post, the Playwright MCP
README, the Zed proxy PR). DNS for docs.github.com, genai.owasp.org, brave.com, wiz.io, playwright.dev,
simonwillison.net and owasp.org failed from here, so quotes from those are from search excerpts or secondary
coverage and are marked UNVERIFIED-PRIMARY. Repo facts come from reading the private access policy, `docs/ARCHITECTURE.md`,
`contract/BACKEND-BRIEF.md`, `src/api/broker.ts`, `src/fixtures/{egress,guard,index}.ts`, `src/config.ts`,
`src/secret.ts`, `scripts/{evidence,post-run}.mjs`, `scripts/global-setup.ts`, the private runner,
`playwright.config.ts`, `.claude/settings.json` and the self-test list.

## 1. Consensus design (2025-2026)

**What the agent vendors ship.**

- *Claude Code (local).* An OS-enforced sandbox around shell commands only (bubblewrap on Linux, Seatbelt on
  macOS). Network: "No direct route out. Connections go through a proxy on your machine that checks each host
  against your allowed domains, which start empty." Reads default to "most of the machine, including credential
  files such as `~/.ssh` and `~/.aws/credentials`", so a `sandbox.credentials` block exists with `deny` (unset env
  vars, deny file reads) and `mask` modes; in mask mode the command sees "a per-session placeholder called the
  sentinel, and the sandbox proxy substitutes the real value on outbound requests to hosts you allow" (needs TLS
  termination; only honoured from user or managed settings, never from a repo's `.claude/settings.json`). The docs
  are explicit that Read/WebFetch, hooks, MCP servers and LSPs "run with your full access", and that "Effective
  sandboxing requires both filesystem and network isolation." `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips credentials
  from all subprocesses. The allowlist proxy itself has failed twice: a SOCKS5 null-byte hostname bypass
  (v2.0.24 to v2.1.89, fixed 2.1.90 on 1 Apr 2026, no CVE, release notes silent) and a relayed-CONNECT bypass
  (issue #87381).
- *Claude Code on the web.* Per-environment network levels None / Trusted / Full / Custom. "Network secrets" are the
  broker pattern as a product: "Anthropic's agent proxy adds the key to requests for the hosts you list, after each
  request leaves the session's VM, so the key itself stays outside the VM"; the GitHub proxy likewise swaps "a
  scoped credential" for the real token and rejects tag pushes and branch deletions. Plain environment variables
  are documented as readable by "anyone who uses the environment".
- *OpenAI Codex CLI.* Network off by default in `workspace-write`; Seatbelt on macOS, bwrap + seccomp on Linux
  (Landlock's role is disputed between sources); `.git/` and `.codex/` forced read-only; a long-open macOS bug
  where `network_access = true` is silently ignored (#10390). Nothing specific on secret handling.
  UNVERIFIED-PRIMARY.
- *GitHub Copilot coding agent.* A firewall with a "recommended allowlist" on by default, custom domains per repo or
  org, a PR warning when a request is blocked; it "only applies to processes started by the agent via its Bash
  tool", not to MCP server processes or setup steps. UNVERIFIED-PRIMARY.
- *Cursor.* `.cursorignore` is not a secrets boundary (terminal and MCP bypass it); two sandbox escapes disclosed
  June 2026 (Cato), CVE-2026-26268 (git hooks via prompt injection, CVSS 9.9); cloud "Runtime Secrets" are env vars
  redacted from transcripts. All secondary sources.
- *Devin.* Repository and personal secrets encrypted and scoped, masked in chat, but present in the sandbox as
  environment variables (the DataCamp walkthrough shows the literal DSN in the shell tab). "Never shown to the
  agent" is not true of Devin; it is "not shown in the transcript".

**Credential brokers and proxies.** The same idea appears under many names: CyberArk Secretless Broker (local
process speaks the target protocol; "the client doesn't need to know the actual password"), Vault Agent injector
and Infisical's agent injector (secrets rendered to tmpfs/shared-volume files, env-var rendering is opt-in),
1Password Secure Agentic Autofill with Browserbase (8 Oct 2025: credentials injected by the extension into the
agent's browser, "not shared with the LLM or exposed in Browserbase logs", human approval per use), agentgateway
(July 2026: "Model A never gives the agent a real credential at all, proxying the call and injecting the credential
on the way out" vs Model B short-lived tokens via RFC 8693), Runloop, OneCLI. NHI Mgmt Group's caveat is the honest
framing: secretless "does not eliminate identity risk, but it changes the risk shape" to abuse of the issuing path.

**Frameworks and incidents.** OWASP Top 10 for Agentic Applications (9 Dec 2025): ASI01 goal hijack, ASI02 tool
misuse, ASI03 identity and privilege abuse, ASI04 supply chain, ASI05 unexpected code execution, ASI06 memory
poisoning, ASI07 inter-agent comms, ASI08 cascading failures, ASI09 human-agent trust, ASI10 rogue agents
(UNVERIFIED-PRIMARY; list consistent across Cycode, Modulos, Promptfoo). OWASP LLM Top 10 2025: LLM01 prompt
injection, LLM02 sensitive information disclosure, LLM06 excessive agency. Willison's "lethal trifecta" (private
data + untrusted content + an exfiltration channel) is the mental model every browser-agent incident fits: Comet
(Brave, Aug 2025: hidden text in a Reddit spoiler made the agent open Gmail and post a one-time passcode), ChatGPT
Atlas injected within 24 h of launch (Oct 2025), "CometJacking" via Comet's MCP API, Playwright MCP issues #1479
(accessibility snapshots are untrusted input), #1495 (RCE via `browser_run_code`) and executeautomation #209
(cookies and localStorage exfiltrated by injected `fetch`); the GitHub MCP private-repo leak (Invariant Labs, May
2025). Microsoft's own README: "Playwright MCP is **not** a security boundary" and `--allowed-origins` "does not
serve as a security boundary" and "does not affect redirects". Supply chain is the other half: s1ngularity (Nx,
26 Aug 2025) prompted installed Claude/Gemini/Q CLIs to hunt `.env`, SSH keys and wallets ("roughly half of all
victims had an AI CLI installed"; 2,180 accounts, 6,700 private repos flipped public); Shai-Hulud (Sept 2025,
500+ packages, TruffleHog bundled, secrets dumped to public repos); Amazon Q VS Code extension 1.84.0 shipped with
an injected "wipe the system" prompt (July 2025); Replit's agent deleted a production database during a code freeze
(July 2025), after which Replit separated dev and prod databases.

**The consensus, in one list.** (1) Run the agent's shell in an OS sandbox. (2) Default-deny egress, enforced at a
boundary the untrusted code cannot reconfigure, resolved and dialled carefully, tested adversarially. (3) Long-lived
credentials never inside the boundary: a broker or proxy injects them per host, scoped, short-lived, audited, with a
human in the loop for anything irreversible. (4) Production unreachable from the agent's environment, not merely
forbidden. (5) Everything a page or tool returns is data, never instruction. (6) Redaction of logs and transcripts
is a courtesy layer; Playwright says it in writing ("a convenience and not a security feature"). (7) One identity
per agent run, every call logged against it.

**Where we sit.** (3), (4), (5) and (7) match closely: the loopback broker is the same shape as Anthropic's network
secrets and GitHub proxy, scoped tighter (contract routes only, no redirects, 1 MiB bodies, constant-time token
check), and the backend's five locks plus the client's four make prod a 404 rather than a policy. (6) is better
than the market norm (scrub by value in four encodings, scan, quarantine, fail-closed deletion). (1) and (2) are
where we are weaker than our pitch: only *browser contexts* sit behind the egress proxy; the Node test process that
the agent writes code for has unrestricted network, and the kit inherits whatever sandbox the host gives it. Section
4 is mostly about that.

## 2. Test-login endpoints: what the frameworks do, and the locks checklist

In-process helpers dominate and are unreachable in production by construction: Devise `sign_in` wraps Warden
`login_as` under `Warden.test_mode!` (no HTTP route); Django `force_login` is a test-client method that still
consults the auth backend; Laravel `actingAs` is in-process; Spring `@WithMockUser` and
`SecurityMockMvcRequestPostProcessors` ship in `spring-security-test` with test scope. HTTP-reachable shortcuts
are the exception and the cautionary tales: Laravel Dusk's `/_dusk/login/{id}` is registered only when
`!app()->environment('production')`, the docs say "you should never register it in your production environment",
and the Winter CMS Dusk plugin shipped exactly that bug as CVE-2024-32003 (CVSS 8.8: "may potentially be used to
gain access to any user account"; fixed by registering routes only when `APP_ENV=dusk`). Cypress-on-Rails puts
`cy.login` routes in a `cypress` namespace loaded only in test. Hosted IdPs avoid a backdoor altogether: Clerk
Testing Tokens are short-lived, instance-bound and bypass *bot detection*, not authentication; Auth0 recommends
ROPG on a dedicated test database connection with the grant enabled only while testing (fails under MFA or
Organizations); Auth.js' guide says use a real provider (Keycloak) or the Credentials provider "in development
mode"; Supabase tests sign in programmatically and inject the session; the Firebase Auth emulator is a separate
local process whose state is wiped on exit; Keycloak impersonation needs the realm-management role plus a
fine-grained permission and only the legacy token-exchange path. The adjacent incident class is debug surface left
in prod: Spring Actuator `/heapdump` and `/env` (Wiz: misconfigured in about one of four environments with exposed
actuators; CVE-2025-48927 TeleMessage), Weaver E-cology's debug endpoint (CVE-2026-22679, exploited), and Optus
2022, where ACMA found "a coding error in the access controls for a dormant, internet-facing API" that sat unused
for years and exposed 9.5 million records.

| # | Lock | What mature teams do | private predecessor status |
|---|---|---|---|
| 1 | Build or wiring exclusion | Test helpers in test scope; routes behind a conditional provider (Dusk), profile (`APP_ENV=dusk`) or `@ConditionalOnProperty` so no handler exists | Have (backend lock 1: no bean without the flag) |
| 2 | Env flag, default off, set only by dev config | Dusk, Auth.js Credentials-in-dev, Clerk dev instances | Have |
| 3 | Boot guard that refuses the flag in prod or staging | Rare in OSS; our boot check is stronger than the norm | Have (lock 2) and tested by `the locks test` |
| 4 | Secret key, constant-time compare, rotation pair, 401 when unset | Clerk tokens, Auth0 client secret | Have (lock 3) |
| 5 | Network: route absent outside dev at the ingress (404), not just 403 | Firebase emulator never deployed; Winter CMS fix | Planned, still open (a platform-team request) |
| 6 | Test-account flag plus address pattern, enforced on every route | Auth0 test connection, Clerk test emails `+clerk_test` | Have (lock 4) |
| 7 | Short session TTL | Clerk tokens short-lived; DPoP literature: short TTL is the floor, binding the ceiling | Have 1 h; shorter is cheap (section 5) |
| 8 | Audit line per call with the key id, handle, IP | SOC 2 CC7.2 expectation | Specified; no export or alerting yet |
| 9 | Rate limit on valid keys and throttling on 401s | Auth0 anomaly detection | 120/min per key; nothing on failed auth |
| 10 | Config test that fails the build if a lock is missing | Winter CMS regression test | Have |
| 11 | Separate database and no production data | Replit post-incident; Auth0 "imitating the production connection type is unnecessary" | Dev only; dev holds real dev users' data (see T9) |
| 12 | Revocation at run end | Session kill on teardown | Need |
| 13 | Monitoring: any `/_test/` hit on prod or staging ingress alerts | Optus lesson: dormant surfaces | Need (one alert rule) |
| 14 | Human approval for irreversible actions | 1Password approvals, Devin | Not applicable on dev; keep it that way by never adding prod |

## 3. Evidence hygiene checklist

Facts worth knowing before writing the checklist: Playwright traces hold request and response headers and bodies,
cookies, form values and DOM snapshots; there is no official redaction option, and the MCP `--secrets` file is
"a convenience and not a security feature". HAR `content: 'omit'` drops bodies, not headers or cookies;
`storageState` is plaintext cookies. GitHub Actions `::add-mask::` matches literal strings, one line at a time,
only after registration, and "most CI masking engines match registered literal values, not every transformation"
(base64, URL-encoded, JSON-escaped forms leak). a CI vendor's secured variables are hidden in logs but readable by
anyone who can edit the pipeline YAML. Sentry's default server-side scrubbing keys on names (`password`, `secret`,
`token`, `api_key`, `auth`, `private_key`) and card-shaped values; Advanced Data Scrubbing adds regex, hashing
and masking but cannot operate on non-string values. Presidio's analyzer (spaCy `en_core_web_lg`) and image
redactor (Tesseract) run offline; the image redactor calls itself "alpha and not production ready".

- [x] Prevent upstream: sessions minted by API (no passwords typed except the `signin` persona), `typeSecret` never `fill`,
  `screenshot: 'off'`, `video: 'off'`, traces `retain-on-failure` with `screenshots: false`, `shot({ mask })` for
  codes, broker so no key is in any worker. (Repo: `playwright.config.ts`, `src/secret.ts`.)
- [x] Scrub by value in every encoding the artefact can hold (plain, URL-encoded, JSON-escaped once and twice),
  after ANSI stripping and with one level of JSON-in-JSON undone; cookies by value harvested from the whole run;
  JWT shape; credential header names; workspace codes by HMAC under a per-run key. (`scripts/evidence.mjs`.)
- [x] Scan after scrubbing; anything secret-shaped left is deleted and listed in `QUARANTINED.md`; a secret *value*
  anywhere fails the run even though it is now redacted; post-run that does not finish deletes the evidence.
- [x] Evidence written to a 0700 staging folder and moved out only after the scan.
- [x] Negative tests of the scrubber (E01-E07) and of the key not reaching workers (B01).
- [ ] Document the data classes and the "cannot" list in a `SECURITY.md` (images, unknown shapes, PII in free text).
- [ ] Optional OCR pass (Tesseract) over PNGs for the run's code HMACs and key or JWT shapes; advisory, never a
  substitute for selector masking, and declared best-effort.
- [ ] Retention: GitHub `reports` artefacts keep 14 days and are downloadable by anyone with repository read; say so.
- [ ] Keep the evidence HMAC key variable out of `docker inspect` (it is passed with `-e`; move it to a staging file like the
  key). Low value (it only keys six-digit code hashes) but it contradicts the "no secret in container settings" line.
- [ ] Treat trace DOM snapshots as untrusted text when the agent reads them (indirect injection, ASI01).

A security reviewer will expect: a written data classification; the scrub being tested, including the encodings;
a fail-closed path; a statement of what images and unknown shapes mean; who can read evidence and for how long; and
no claim that OCR or regexes are complete.

## 4. Threat model

Priorities: H = fix before the public release, M = fix in the first quarter, L = document.

| # | Attack | Current mitigation | Gap | Recommended fix | Pri |
|---|---|---|---|---|---|
| T1 | Agent-written test code exfiltrates from the Node worker: `fetch()`, `node:net`, a fresh `chromium.launch()` without `proxy`, `playwright.request.newContext()`. In docker mode `docker run` uses the default bridge with full egress. | Nothing network-level; the guard and egress proxy cover only fixture-created browser contexts. What the worker holds: the per-run broker token (loopback only), minted session cookies for dev test accounts (1 h), the sign-in password file variable (readable by test code), synthetic data. Not the runner key (B01). | The pitch says "the agent cannot reach anything but dev"; today that is true of the browser, not of the process. | Run the whole run in a network namespace whose only route is an egress proxy: docker `--network` on an `internal` network plus a proxy container with a leg on the outside (or an nftables init like Claude Code's devcontainer `init-firewall.sh`); native mode marked "not isolated" in `doctor`. Add a lint gate (section 5, F3). | H |
| T2 | Agent reads the broker's memory (it lives in Playwright's main process; workers are its children). | Linux with Yama `ptrace_scope=1` (Ubuntu default) blocks a child attaching to its parent; macOS `task_for_pid` needs the debugger entitlement (lldb has it) and a non-hardened target. `.claude/settings.json` denies `ps`, `/proc`, `docker exec`. | Node from nvm or Homebrew is usually not hardened-runtime signed (check `codesign -d -vvv $(which node)`), so `lldb -p <pid>` by the same macOS user likely works; `lldb`, `gdb`, `gcore` are not in the deny list; prefix rules are "a backstop, not a boundary" (the private access policy). | Move the broker out of the test process tree: its own process (own container in docker mode, different `--user`), key read there, workers reach it over loopback or a 0700 Unix socket; mark it non-dumpable; add `lldb`, `gdb`, `gcore`, `vmmap` to the deny list; prefer docker mode on macOS. | M |
| T3 | Exfiltration through an allowed host: `firebase.googleapis.com` accepts any project id, `hooks.stripe.com`, query strings on `fonts.googleapis.com`. | Allowlist is narrow and regex-exact; company hosts can never be listed (startup assertion in guard.ts); analytics aborted. | Host-level allowlists cannot tell "the app's Firebase project" from "the attacker's". Blast radius is still dev cookies and synthetic data. | Default third-party hosts to `fulfill` from a recorded cache in CI (Playwright `route`) so no real third-party egress is needed; where live is required, log method, host and byte counts per test and surface outliers in `SUMMARY.md`. Path or body policy would need TLS termination; not worth it yet. | M |
| T4 | DNS rebinding or a name that resolves to a private address: the proxy judges the *name* and dials by name; a passing name could point at `127.0.0.1` (the broker port) or `169.254.169.254` on CI. | Only exact dev, staging and listed third-party names pass; a company subdomain needs the company's DNS; the broker also needs the token header. | Classic TOCTOU: "resolves once for the check, again for the connect"; no private-range check; no connection pinning. | Resolve once, reject loopback, link-local, RFC 1918 and `0.0.0.0/8` unless target is `local`, dial the IP with the original Host and SNI, pin per connection and bound header sizes and connection counts (the Zed PR #59220 design); self-test G13 with a rebinding mock. | M |
| T5 | Proxy bypass via browser flags or options: a test sets `launchOptions.args` (`--proxy-server=direct://`, `--proxy-bypass-list=*`, `ignoreDefaultArgs`) or `test.use({ proxy })`. | The fixture sets `proxy: { server }` per context; G09-G11 prove the proxy works in the default setup. | Whether a per-context proxy survives conflicting launch args is UNVERIFIED (Chromium applies `--proxy-bypass-list` "only in tandem with `--proxy-server`"); WebKit per-context proxy support differs by platform. | A positive control: the fixture makes one canary request per context and fails the test unless *its* proxy saw it; a self-test that overrides `launchOptions` and expects the canary to fail; lint ban on `launchOptions`, `proxy`, `ignoreDefaultArgs` in `tests/`. Cheap and decisive. | H |
| T6 | WebKit WebRTC sends UDP (STUN, TURN) around the HTTP proxy; a TURN relay is a data channel. | Chromium: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (G12). WebKit: none; documented gap; the app has no WebRTC. | A compromised third-party script or test code could still open an `RTCPeerConnection` in WebKit. | The T1 network namespace closes it for every engine (UDP has nowhere to go). Until then, state the gap and run WebKit only inside docker mode with the namespace. | M |
| T7 | CI exposes the key: a CI vendor's secured variables are in the environment of every process in the step; the private runner takes the value over and unsets it, but it has already been in the parent shell and any earlier step command. | the private dev pipeline runs from `main` only, for admins only. Secured variables are masked in logs. | "Masked" is not "hidden": anyone who can edit the YAML can read it; the GitHub workflow for the real suite does not exist yet. | the CI vendor's OIDC token, exchanged for a short Infisical access token *inside* the private runner (Infisical's OIDC auth is generic JWT; a vendor-specific walkthrough is not documented, UNVERIFIED); on GitHub, an environment with required reviewers and OIDC. The key then exists only in the script's unexported variable. | H |
| T8 | Replay of minted cookies: the session cookie is in worker memory, traces (network headers), `results.json`, storage state. | HttpOnly, Secure, host-only, `Max-Age=3600`, a second session ends the first (single-session accounts), scrub by value, leak check. | A copied cookie works for up to an hour against a dev test account; no revoke at run end; no binding (Token Binding is dead, Chrome removed it in 130; DPoP does not apply to cookies). | `POST /_test/runs/{runId}/cleanup` also revokes every session minted under the run; the broker calls it in global teardown; TTL 20-30 min with the broker re-minting on the sign-out signal when a suite runs long. | M |
| T9 | Test-account flag abuse: an attacker who can register `qa+x@example.com` (the catch-all mailbox) gets an account the test API can mint sessions for; a flagged account joins a *real* dev user's workspace; `personas/reset` or `workspaces` DELETE on another slot's data (the broker does not scope by namespace, the backend scopes only sweepers). | Pattern enforced server-side; "never puts a non-test account into a test workspace"; dev only. | Flag by *pattern* is weaker than flag by *provenance*; cross-slot actions are possible with any valid run token; dev holds real dev users' data. | Set the flag only on accounts the test API created (refuse `ensure` for a pre-existing profile); refuse a flagged account joining a non-test workspace; scope mutating routes by `slot` and `namespace` in the broker (it already knows `config.slot`). | M |
| T10 | Rate-limit gaps: 120/min per valid key; no throttle on 401s; one run can hammer sweepers and sinks. | Constant-time compare; long random key makes guessing infeasible. | No alert on a burst of 401s or on calls from an unknown source IP; sweepers are synchronous and scoped but unbudgeted. | Per-IP 401 throttle with an audit alert; per-route budgets; `health` reports key age; source-IP allowlist for `/_test/` once runner egress IPs are stable. | L |
| T11 | Supply chain of the kit: npm deps, the Playwright image, and the plugin marketplace where "every commit on `main` is an update" to every agent that installed it. | Exact versions, lockfile, `npm ci`; private repo; PRs required (branch protection still open in the private repo). | Image pinned by tag not digest; no `--ignore-scripts`, provenance or signature check; auto-updating skills from `main` are a one-PR path to every teammate's agent (Amazon Q 1.84.0 is the template). | Pin `mcr.microsoft.com/playwright@sha256:...`; `npm ci --ignore-scripts` and `npm audit signatures`; Renovate with a release-age cooldown; CODEOWNERS and two reviews for `plugin/`, `.claude/`, `bin/`, `scripts/`; version the plugin from signed tags instead of `main`; publish an SBOM. | H |
| T12 | Indirect prompt injection into the agent through evidence: trace DOM snapshots, console lines and mail-sink bodies are page text the agent reads later. | Skill frames evidence as data; dev content is synthetic; agent never browses live. | No mechanical defence; this is ASI01 and cannot be closed, only bounded. | Say so in the skill and docs; keep the agent's own session sandboxed (Claude Code `sandbox.credentials` deny for `~/.kube`, `~/.config/infisical`, the staging folder; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`); ship that settings block. | L |
| T13 | The sign-in password is a secret test code can read (the sign-in password file variable is in the worker environment; `typeSecret` reads it). | Scrub by value catches it in output; it is one dev persona's password. | It contradicts an absolute "never touches a secret" claim. | Have the fixture read the file into a `Secret` before any test runs and delete it; forbid `fs` in `tests/` by lint; longer term replace the password with a one-time sign-in token the broker fetches when the sign-in test starts. | L |

## 5. Security features we should add

1. **F1. A network namespace around the whole run** (T1, T6): docker mode starts an `internal` network, a
   sidecar egress proxy (the existing `egress.ts` policy) with a second leg outside, and the run container with no
   other route; `doctor` reports "isolated" or "not isolated"; native mode prints a warning. One self-test proves
   Node `fetch` to an unlisted host fails.
2. **F2. A per-context positive control** (T5): the fixture issues a canary request and fails unless its own proxy
   logged it; a self-test overrides `launchOptions` and expects that failure.
3. **F3. A test-code lint gate in `npm run check`**: forbid in `tests/` the identifiers `chromium`, `webkit`,
   `firefox`, `launch`, `newContext`, `request.newContext`, `launchOptions`, `proxy`, `ignoreDefaultArgs`,
   `node:http`, `node:https`, `node:net`, `child_process`, `fs`, `process.env`, raw `fetch(`; allow them only
   under `src/fixtures/`. Prefix rules are a backstop; this is one more, and it runs in CI.
4. **F4. Egress proxy hardening** (T4): resolve once, private-range rejection, dial the IP with original Host and
   SNI, connection pinning, bounded headers and connection counts; G13 rebinding self-test.
5. **F5. Broker out of the process tree** (T2): own process or container, own user, non-dumpable, Unix socket in a
   0700 dir; `lldb`, `gdb`, `gcore`, `vmmap`, `leaks` added to the deny list; docker mode default on macOS.
6. **F6. Session revocation and shorter TTL** (T8): run-scoped revoke in `cleanup`, called from global teardown;
   contract, client and mock changed together per CLAUDE.md.
7. **F7. OIDC for CI** (T7): CI OIDC to the secret manager inside the private runner; GitHub environment with required
   reviewers; no static key variable anywhere.
8. **F8. Supply-chain pins** (T11): image digest, `--ignore-scripts`, `npm audit signatures`, Renovate cooldown,
   CODEOWNERS, signed release tags for the plugin, SBOM in the release.
9. **F9. Provenance-based test-account flag and slot scoping** (T9).
10. **F10. Audit export**: `GET /_test/audit?runId=` and an `AUDIT.md` in every evidence folder (key id, handle,
    route, IP, time); an alert on any `/_test/` request reaching prod or staging ingress.
11. **F11. `<kit> doctor --security`**: prints which layers are active on this machine (netns, Yama scope,
    hardened Node, deny rules, sandbox settings, image digest) so a reviewer can verify instead of trusting.
12. **F12. `SECURITY.md` and a published threat model** (this table, kept current in `DECISIONS.md`), with a
    disclosure address and the explicit "not a security boundary" sentence for the pieces that are not.
13. **F13. A shipped `.claude/settings.json` sandbox block** for sessions in this repo: `sandbox.credentials` deny
    entries for `~/.kube`, `~/.config/infisical`, `~/.cache/<kit>`, and the note that `mask` entries are only
    honoured from user or managed settings.
14. **F14. Optional offline OCR pass** on PNGs, advisory only (section 3).

## 6. Claims we may make, and claims we must not

**Safe to claim (true today, and testable):**

- "The AI agent and the test code never hold the backend test-API key. Only a loopback broker in the runner does,
  and a self-test (B01) proves the workers do not." (T2 caveat belongs in the threat model, not the headline.)
- "The key is never in an environment variable, on a command line or in a container's configuration during a run;
  it moves as a 0600 file that global setup reads and deletes."
- "Every persona browser runs behind its own egress proxy that refuses production and unlisted hosts before any
  connection or DNS lookup, including redirect hops and WebSockets; Chromium sends no WebRTC UDP."
- "Evidence is scrubbed by value in four encodings, then scanned; anything still secret-shaped is deleted and
  listed; a leaked secret value fails the run; evidence that was not fully processed is deleted, never kept."
- "Sessions are minted only for flagged synthetic test accounts, only on dev, expire in one hour, and every call is
  audited with the key id. Nobody signs in as a real person; no shared human credentials exist."
- "Production is refused by four client-side locks and is a 404 at the backend's five locks." (Say "once the ingress rule lands"
  until the ingress rule exists.)
- "We publish our threat model and the gaps we have not closed."

**Must not claim (false, unprovable, or legally loaded):**

- "The agent cannot exfiltrate anything" or "sandboxed end to end": the Node worker is unrestricted until F1 ships,
  and the kit is not an OS sandbox. Borrow Microsoft's sentence: the framework is not a security boundary; the
  broker and the backend locks are.
- "Secrets never touch the agent" as an absolute: the broker token, minted cookies and the sign-in password are in
  the worker; say "the long-lived credential".
- "Prevents prompt injection": nothing does; we bound its blast radius.
- "Impossible to run against prod": it is refused by code the agent could edit; the real boundary is the backend.
- "SOC 2 compliant" or "ISO 27001 certified": a kit cannot be; it "supports controls" (next section).
- "Screenshots contain no secrets or PII": regexes cannot read images; OCR is best-effort.
- "No secrets in CI" until OIDC replaces the pipeline variable.
- Anything that names 1Password, Anthropic, GitHub or OWASP as endorsing the kit.

## 7. Compliance angles

Control titles below are verified from public listings; the control *text* of ISO/IEC 27001:2022 is paywalled and
SOC 2's points of focus come from AICPA TSP 100, so phrase everything as "supports", never "satisfies".

- **SOC 2 (Security):** CC6.1 logical access and least privilege (one scoped key, test accounts only, no shared
  human logins); CC6.2 credential issuance tied to an identity (personas created and flagged by API, key per
  runner, rotation pair); CC6.3 role-based, least-privilege authorisation (route and namespace scoping);
  CC6.6 boundary protection (egress allowlist, prod refusal); CC6.7 restriction of transmission (key never leaves
  the broker; evidence scrubbed); CC7.2 monitoring (an audit line per call, leak check fails the run); CC8.1
  change management (PR-only `main`, locks test in the build).
- **ISO/IEC 27001:2022 Annex A:** 5.15 access control, 5.16 identity management (synthetic identities), 5.17
  authentication information (no sharing, no human credential in the loop), 5.18 access rights, 8.2 privileged
  access rights, 8.3 information access restriction, 8.5 secure authentication, 8.11 data masking (scrub), 8.12
  data leakage prevention (scan, quarantine, fail closed), 8.15 logging, 8.16 monitoring, 8.28 secure coding,
  8.29 security testing in development and acceptance, 8.31 separation of development, test and production
  environments (the five locks), 8.33 test information (synthetic personas, no real PII).
- **Language security teams respond to:** "no standing credential inside the agent's trust boundary"; "scoped,
  short-lived, audited, revocable"; "blast radius: one dev test account for at most one hour"; "fail closed";
  "defence in depth with the enforcing boundary on the server"; "we tested the controls adversarially (self-tests
  G01-G12, B01-B03, E01-E07) and we list what we have not closed". Avoid "zero trust" and "military-grade".

## Sources

Fetched primary: Claude Code sandboxing docs <https://code.claude.com/docs/en/sandboxing>; cloud environments
<https://code.claude.com/docs/en/cloud-environments>; Anthropic engineering, sandboxing
<https://www.anthropic.com/engineering/claude-code-sandboxing>; Playwright MCP README
<https://github.com/microsoft/playwright-mcp/blob/main/README.md>; Zed allowlist proxy PR
<https://github.com/zed-industries/zed/pull/59220>.

Agent vendors (excerpt-sourced unless noted): Claude Code bypasses
<https://www.securityweek.com/anthropic-silently-patches-claude-code-sandbox-bypass/>,
<https://oddguan.com/blog/second-time-same-sandbox-anthropic-claude-code-network-allowlist-bypass-data-exfiltration/>,
<https://github.com/anthropics/claude-code/issues/87381>; Codex
<https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/> (UNVERIFIED-PRIMARY),
<https://github.com/openai/codex/issues/10390>,
<https://cdn.openai.com/pdf/ac7c37ae-7f4c-4442-b741-2eabdeaf77e0/oai_5_2_Codex.pdf>; Copilot firewall
<https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall>
(UNVERIFIED-PRIMARY),
<https://github.blog/changelog/2025-07-15-configure-internet-access-for-copilot-coding-agent/>; Cursor (secondary)
<https://medium.com/@Koukyosyumei/a-cursor-sandbox-escape-shows-why-ai-agents-need-kernel-boundaries-281efdb56396>,
<https://howtoharden.com/guides/cursor/>; Devin <https://docs.devin.ai/product-guides/secrets>,
<https://www.datacamp.com/tutorial/devin-ai-security-deployment>.

Brokers and proxies: 1Password <https://1password.com/press/2025/oct/browserbase-ai-security-partnership>,
<https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents>; CyberArk
<https://www.conjur.org/secretless>,
<https://developer.cyberark.com/blog/introducing-the-secretless-broker-open-source-beta/>; Vault injector
<https://developer.hashicorp.com/vault/docs/v1.18.x/platform/k8s/injector-csi>; Infisical injector
<https://infisical.com/docs/self-hosting/helm-charts/agent-injector>, the CI vendor
<URL removed: names the private predecessor's CI vendor>, OIDC auth
<https://infisical.com/docs/documentation/platform/identities/oidc-auth/gitlab>; agentgateway
<https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/>; Runloop
<https://runloop.ai/blog/protect-api-keys-with-agent-gateway>; secretless caveat
<https://nhimg.org/glossary/secretless-architecture/>.

Frameworks: OWASP Agentic Top 10
<https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> (UNVERIFIED-PRIMARY), via
<https://cycode.com/blog/owasp-top-10-agentic-applications/> and
<https://docs.modulos.ai/frameworks/owasp-top-10-agentic>; OWASP LLM Top 10 2025
<https://owasp.org/www-project-top-10-for-large-language-model-applications/>; lethal trifecta
<https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/> (UNVERIFIED-PRIMARY).

Incidents: Comet <https://brave.com/blog/comet-prompt-injection/> (UNVERIFIED-PRIMARY); Atlas
<https://thehackernews.com/2025/10/chatgpt-atlas-browser-can-be-tricked-by.html>; CometJacking
<https://securityboulevard.com/2025/11/comet-browser-mcp-flaw-enables-hijacking-full-control-of-user-devices/>;
Playwright MCP <https://github.com/microsoft/playwright-mcp/issues/1479>,
<https://github.com/microsoft/playwright-mcp/issues/1495>,
<https://github.com/executeautomation/mcp-playwright/issues/209>; GitHub MCP
<https://invariantlabs.ai/blog/mcp-github-vulnerability> (UNVERIFIED-PRIMARY); s1ngularity
<https://www.wiz.io/blog/s1ngularitys-aftermath> (UNVERIFIED-PRIMARY),
<https://www.bleepingcomputer.com/news/security/ai-powered-malware-hit-2-180-github-accounts-in-s1ngularity-attack>,
<https://www.securityweek.com/over-6700-private-repositories-made-public-in-nx-supply-chain-attack/>; Shai-Hulud
<https://krebsonsecurity.com/2025/09/self-replicating-worm-hits-180-software-packages/>,
<https://www.stepsecurity.io/blog/ctrl-tinycolor-and-40-npm-packages-compromised>; Amazon Q
<https://research.jfrog.com/post/amazon-q-vs-code-extension-compromised-with-malicious-code/>,
<https://www.csoonline.com/article/4027963/hacker-inserts-destructive-code-in-amazon-q-as-update-goes-live.html>;
Replit <https://www.heise.de/en/news/Artificial-intelligence-Vibe-coding-service-Replit-deletes-production-database-10499597.html>.

Test logins: Devise <https://rubydoc.info/github/heartcombo/devise/Devise/Test/IntegrationHelpers>; Django
<https://docs.djangoproject.com/en/stable/topics/testing/tools/#django.test.Client.force_login>; Laravel Dusk
<https://laravel.com/docs/dusk>, <https://github.com/laravel/dusk/blob/master/src/DuskServiceProvider.php>;
CVE-2024-32003 <https://nvd.nist.gov/vuln/detail/CVE-2024-32003>; Spring
<https://docs.spring.io/spring-security/reference/6.5/servlet/test/mockmvc/authentication.html>; Actuator
<https://www.wiz.io/blog/spring-boot-actuator-misconfigurations>; Auth.js <https://authjs.dev/guides/testing>;
Clerk <https://clerk.com/docs/guides/development/testing/overview>,
<https://clerk.com/docs/guides/development/testing/playwright/overview>; Auth0
<https://support.auth0.com/center/s/article/automated-testing-with-identifier-first-universal-login>; Firebase
<https://firebase.google.com/docs/emulator-suite/connect_auth>; Keycloak (secondary) <https://skycloak.io/?p=3267>;
Cypress <https://docs.cypress.io/app/end-to-end-testing/testing-your-app>,
<https://www.shakacode.com/blog/introduction-to-cypress-on-rails/>; Optus
<https://cyberdaily.au/security/10731-acma-says-coding-error-to-blame-for-optus-cyber-attack>; Weaver
<https://vega.io/blog/ping-payload-powershell-active-exploitation-of-cve>.

Evidence hygiene: GitHub masking <https://github.com/actions/toolkit/blob/main/docs/commands.md>,
<https://qaskills.sh/blog/ci-mask-secrets-in-test-logs>; Playwright leaks
<https://currents.dev/posts/playwright-avoid-data-leak>, HAR
<https://qaskills.sh/blog/playwright-starthar-tracing-guide>; the CI vendor
<URL removed: names the private predecessor's CI vendor>;
Sentry <https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/>,
<https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/>; Presidio
<https://pypi.org/project/presidio-image-redactor/>.

Threat model: DNS rebinding <https://techearl.com/dns-rebinding-ssrf>,
<https://github.com/nccgroup/singularity/wiki/Protection-Bypasses>; Chromium proxy flags
<https://www.chromium.org/developers/design-documents/network-settings>,
<https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md>; Yama
<https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html>; Docker seccomp
<https://docs.docker.com/engine/security/seccomp/>, <https://jvns.ca/blog/2020/04/29/why-strace-doesnt-work-in-docker/>;
macOS task ports <https://developer.apple.com/forums/thread/701647>; devcontainer firewall
<https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh>; token binding
<https://nhimg.org/articles/sender-constrained-tokens-and-what-token-binding-failed-to-teach/>.

Compliance: SOC 2 CC6 <https://www.hicomply.com/hub/soc-2-controls-cc6-logical-and-physical-access-controls>,
<https://www.bytebase.com/blog/database-access-control-for-soc2/>; ISO 27001:2022 control list
<https://hightable.io/iso-27001-annex-a-controls-list/>,
<https://www.bsigroup.com/globalassets/localfiles/en-th/webinars/webinar-iso27001-2022-transition--october-2022-r1.pdf>.
