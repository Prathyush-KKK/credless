# 01 – Competitors and white space for the "agent-safe signed-in E2E kit"

> **Dated working document.** This is a copy of a research report written on 18 Oct 2026, before the first line of
> credless was written, kept here because the README, SECURITY.md and the roadmap cite it. It is not maintained:
> versions, star counts, prices and issue states are as they were on that day, and marks such as "unverified" or
> "2nd-hand" are the author's at the time. References to the private predecessor (the internal framework this kit
> was generalised from) were replaced by that phrase and its internal names by generic ones; nothing else was edited.

Date: 2026-10-18. Scope: who else solves parts of what the private predecessor does, generalised as a public kit. The seven pieces are referred to by number throughout:

1. synthetic persona catalog, one account per persona per worker
2. dev-only test API that mints real session cookies and sets state in one call
3. loopback broker holding the runner key so workers/agents never see it
4. per-browser guard + egress proxy refusing prod, unlisted hosts, redirects, WebSockets, WebRTC
5. evidence pipeline: private staging, scrub + scan, run FAILS on a leaked secret, masked shots, contact sheets, SUMMARY/COVERAGE/FLAKES
6. runner: slots, run locks, `--twice` flake detection, `doctor`
7. Claude Code skill: expected behaviour first, case list, cheapest layer, triage

Method note: GitHub, raw.githubusercontent.com and search were reachable; most vendor domains (playwright.dev, clerk.com, momentic.ai, qawolf.com, checklyhq.com, mabl.com, currents.dev, argos-ci.com, chromatic.com, docs.browser-use.com, docs.stacklok.com and others) were DNS-blocked from this sandbox. Where a fact comes only from a search snippet or a third-party page it is marked **(2nd-hand)**; where I could not confirm it at all it is marked **(unverified)**. Star counts are as GitHub showed them on 2026-10-18.

## 1. Comparison table

"Covers" means the tool genuinely does that job, "~" means partial or a different shape.

| Tool | Type | Stars / pricing | Covers | Notes |
|---|---|---|---|---|
| **Playwright auth docs** (storageState, setup projects, per-worker accounts, multiple roles) | OSS, first-party docs | n/a | ~1 | Teaches "one account per parallel worker" keyed on `parallelIndex` and "testing multiple roles together" with separate contexts, but leaves account acquisition, credentials and secrecy to you; warns the `.auth` state file "could be used to impersonate you". No server-side minting, no guard, no scrub. |
| **playwright-persona** (kettanaito) | OSS, MIT | 135 | ~1 | `definePersona`/`combinePersonas`/`authenticate({as})` with `createSession`/`verifySession`/`destroySession`; sessions saved as `storageState` per test. Credentials from env in test code. Proposed as first-party in microsoft/playwright #36540; maintainers declined ("not ready to commit", "auth was not a major pain point for the team"). Closest OSS to piece 1. |
| **Clerk Testing Tokens** (`@clerk/testing`) | Commercial auth vendor, OSS helper | part of Clerk plans | ~2 | Short-lived token from the Backend API, passed as a query param on Frontend API calls to bypass bot detection; `setupClerkTestingToken({page})`; sign-in helpers skip MFA/verification. Needs `CLERK_SECRET_KEY` in the test environment. Production instances supported since Aug 2025 **(2nd-hand)**, i.e. the opposite of a prod lock. |
| **Cypress `cy.session`** | OSS | n/a | ~1 | Caches cookies/localStorage/sessionStorage per id, `validate`, `cacheAcrossSpecs`, switch users mid-test. Docs warn the id is shown in the reporter so do not put secrets in it. No minting, no guard. |
| **cypress-playwright-on-rails** (shakacode) | OSS, MIT | 454 | 2, ~3 | `app_commands`, scenarios, Factory Bot, clean; middleware off in production by default; optional `middleware_token` header (shared secret lives in test config). No session minting helper; the README says "write it yourself". Best existing shape of a framework-specific test API. |
| **Laravel Dusk `loginAs`** | OSS | part of Laravel | ~2 | `/_dusk/login/{userId}/{guard?}` registered only when `!environment('production')` (source checked). CVE-2024-32003 in Winter CMS's Dusk plugin shows what happens when that guard is weaker. No key, no audit, no cross-account state helpers. |
| **Django** | OSS | n/a | – | `Client.force_login` is unit-test only; no standard browser-level backdoor found. Community pattern is UI login + storageState **(2nd-hand)**. Gap. |
| **Supabase** | Commercial BaaS | free tier+ | ~2 | Community pattern: `signInWithPassword` server-side with the service-role key, write session into `sb-*-auth-token` localStorage or storageState; DB trigger for deterministic OTP for test addresses **(2nd-hand)**. `auth.admin.generateLink` exists but no E2E recipe found **(unverified)**. Service-role key sits in CI/test env. |
| **Firebase Auth emulator** | OSS/free | free | ~2 | Local emulator (`firebase emulators:start --only auth`, `connectAuthEmulator`); `nearform/playwright-firebase` plugin uses a service account + test UID. Local only, no staging story. |
| **Auth0** | Commercial | – | ~2 | Resource Owner Password grant for API login (must be enabled per tenant) **(2nd-hand)**. Credentials in env. |
| **WorkOS Emulate** | OSS emulator from a commercial vendor | free | ~1, ~2 | In-memory WorkOS API emulator with `--interactive` real login pages, seed file for users/orgs/roles, magic-link and verification codes readable from emitted events, test key `sk_test_default` **(2nd-hand)**. Nearest thing to "seeded personas + codes without a mailbox", but local, vendor-specific. |
| **Mailpit** | OSS, MIT | 10.7k | adjunct to 2 | SMTP sink + REST API + webhooks + chaos. Successor to **MailHog** (16.2k, MIT, unmaintained). |
| **Mailosaur / Mailtrap** | Commercial sinks | Mailosaur ~$20–62/mo; Mailtrap sandbox ~$14–34/mo **(2nd-hand, sources conflict)** | adjunct to 2 | Hosted inboxes with OTP/SMS extraction APIs. |
| **Testcontainers** (java 8.8k, node 2.6k) | OSS, MIT | – | adjunct to 2/6 | Throwaway dependencies for hermetic runs; nothing about auth or secrets. |
| **Playwright MCP** (microsoft) | OSS, Apache | 38.3k | ~3, ~4 | `--secrets` dotenv file: matching text in tool responses is replaced, documented as "a convenience, not a security feature". `--allowed-origins`/`--blocked-origins` were removed in 0.0.47, restored after #1210, and documented as "not a security boundary" and not applied to redirects. Passwords were serialised in a11y snapshots (#1566); maintainer answer: use `--secrets`, "enough data is passed to LLM to compromise your system if LLM is not trusted". |
| **Playwright CLI** (microsoft) | OSS | 14.3k | ~3, ~4, ~7 | "Playwright CLI with SKILLS", "token-efficient" for Claude Code/Copilot; `state-save/load`, named sessions, same `PLAYWRIGHT_MCP_SECRETS_FILE` and origin lists with the same "not a security boundary" caveat. Ships skills (session management, storage state, tracing) which overlap piece 7 in form, not in method. |
| **Playwright Agents** (planner/generator/healer, v1.56+) | OSS | – | ~7 | `npx playwright init-agents --loop=claude|codex|vscode|opencode` **(2nd-hand)**. Method is "explore, write, heal"; no persona/secret/evidence doctrine. |
| **Stagehand** (Browserbase) | OSS, MIT + cloud | 25.7k | ~3 | `act()` `variables` "are not shared with LLM providers"; `observe()` returns selectors so "credentials never reach the model"; `verbose: 0` advised for secrets. Secret still in the Node process env. |
| **Browser Use** | OSS, MIT + cloud | 118.4k | ~3, ~4 | `sensitive_data` placeholders (`x_user`, `x_pass`) filtered from model input, scoped per domain glob; `allowed_domains`; docs warn vision models still see the page image. Issue #5879: default profile allows all hosts and leaves IP URLs unblocked. |
| **1Password Secure Agentic Autofill** (with Browserbase) | Commercial, early access (Oct 2025) | with 1Password | 3 | Credentials autofilled over an E2E-encrypted channel into the agent's headless browser; "raw credentials never enter the LLM context"; human approval per sign-in by default; TOTP at runtime **(2nd-hand, vendor claims)**. Strongest piece-3 story on the market, but interactive, Browserbase-only, one human per login, no personas, no evidence. |
| **Magnitude** | was OSS AI test framework | 7.1k (today) | – | The repo `magnitudedev/magnitude` README now describes an inference engine ("Run open models as fast as your hardware allows"); no testing content remains. Treat the testing product as gone. |
| **Shortest** (antiwork) | OSS, MIT | 5.7k | ~7 | Plain-English tests on Playwright + Claude; Mailosaur and TOTP helpers; credentials from `.env.local`. One commit in 2026 (May 21); effectively dormant. |
| **bug0 `qa-agent`** | OSS, FSL-1.1-Apache | 1.3k | ~7 | "The open-source Playwright library for AI regression testing": Redis step cache, auto-heal, Claude+Gemini dual verification with arbiter, email extraction. API keys and data from env/Redis. No secret isolation, no guard, no leak check. |
| **understudy** (ImJongHyuk) | OSS, MIT, 0.x | 0 | ~5, ~7 | Harness over Playwright Agents with "deterministic, LLM-free trust gates" (negative-control, no-mock-of-SUT, intent-freshness, post-heal-lint), auth lifecycle in adapters, an "OSS leak guard". Tiny, but the closest in philosophy to piece 7 + 5. |
| **Momentic** | Commercial | free 2k credits; PAYG $125/mo for 10k credits; 1 credit/step, 2 for AI steps **(2nd-hand)** | ~2, ~5, ~6 | Agentic E2E for web/iOS/Android, YAML tests. Auth docs: creds from env vars, Momentic-provisioned inbox + regex for magic links, TOTP via `otpauth` in a JS step; advises against SSO logins. |
| **QA Wolf** | Managed service | ~$40–44 per test per month, median ACV ~$90k **(2nd-hand)** | 5, 6 (as a service) | Headline: "80%+ coverage in weeks", "0% flake rate" (with 3 retries and a human validating every failure). Humans handle accounts and secrets. |
| **Octomind** | was commercial | – | – | Product turned off end of May 2026, company wound down end of June 2026 **(2nd-hand, consistent across sources)**; all GitHub repos archived (octomind-mcp 24 stars, debugtopus 26). Cited reason: lack of market validation. |
| **TestDriver.ai** | OSS SDK + cloud | 400 stars; free 60 min, Pro $20/mo, Team $600/mo **(2nd-hand, sources conflict)** | ~6 | Vision/computer-use agent on ephemeral cloud devices; vitest plugin; MCP init for Cursor/Claude. API key in `.env`. |
| **Checkly** | Commercial; CLI Apache (95 stars) | Hobby free; ~$24/$64 per month **(2nd-hand, conflicting)** | ~5, ~6 | Monitoring-as-code with `@playwright/test` check suites (GA Oct 2025), private locations, Rocky AI root-causes failures. Secrets as env-type variables **(from memory, unverified)**. Scheduled production checks are the point; no prod lock by design. |
| **Autify** (Nexus, Genesis, Aximo) | Commercial | Aximo from $99/mo; Nexus ~$3,600/yr **(2nd-hand, conflicting)** | ~6 | Nexus is Playwright-based; Genesis generates tests from requirements. |
| **mabl** | Commercial, quote-based | Core ~$500/mo **(2nd-hand)** | ~3 | "mabl credentials": encrypted with a customer key, Basic/Cloud, MFA TOTP variants; Cloud credentials cannot be retrieved after save (and cannot be used locally). Vault-style, inside their cloud. |
| **Reflect** (SmartBear) | Commercial | from $99/user/mo or $225/mo team **(2nd-hand, conflicting)** | – | Codeless recorder; email/SMS testing claimed **(from memory, unverified)**. |
| **Meticulous** | Commercial, no public price | – | ~5 | Records real sessions, replays on PR with network answered from the recording, screenshot diffs. Side-steps auth and multi-user entirely; not a signed-in real-server tester. |
| **Currents** | Commercial (self-host Helm available) | ~$49/mo usage-based **(2nd-hand)** | ~5, ~6 | "All-in-one Dashboard for Playwright Testing": orchestration, flaky detection and quarantine, `currents-mcp` (21 stars). Wrote "How Playwright Tests Leak Data" (traces, HAR, reporter output, fixture logs on retry). |
| **TestDino** | Commercial | $39/mo annual, 3 users **(vendor pages)** | ~5 | Playwright reporting with MCP server and a "data redaction" doc **(unverified: domain blocked)**. |
| **Argos** | OSS, MIT + cloud | 641 stars; free 5k shots, Pro $100/mo for 35k | ~5 | "The open source visual testing platform for teams and AI agents"; captures in your own Playwright browser. |
| **Percy** (BrowserStack) | Commercial | from ~$599/mo **(2nd-hand, competitor blog)** | ~5 | DOM upload + cloud re-render. |
| **Chromatic** | Commercial | free 5k snapshots; ~$179/mo for 35k **(2nd-hand)** | ~5 | Storybook-first; Playwright/Cypress supported. |
| **QA.tech / TestSprite / Ranger** (2025–26 entrants) | Commercial | QA.tech $500/mo per 1,000 executions; TestSprite $19–39/mo; Ranger annual contracts **(2nd-hand)** | ~6 | Autonomous "AI QA engineer" positioning; none publish anything on secret isolation or prod guards. |

Nothing in the table covers piece 3 the way the broker does (key never in any environment, never in a worker), nothing covers piece 4 at the network layer for a test run, and nothing covers the "run fails on a leaked secret" half of piece 5.

## 2. White space

**Does anything combine agent-safe secret handling + multi-user personas + egress/prod guard + leak-failing evidence?** No. I looked for it directly and found only pieces, in three clusters that do not talk to each other:

- *Browser-agent SDKs* (Browser Use, Stagehand, Playwright MCP/CLI, 1Password Agentic Autofill) solve "the model must not see the password" for an agent driving a browser interactively. All but 1Password still put the secret in a dotenv/env on the machine the agent's shell runs on; Playwright's own docs call both the redaction and the origin lists conveniences, "not a security boundary", and say they do not apply to redirects. None has personas, state APIs, or evidence. 1Password is the real exception on secrecy, and it is per-login human approval on Browserbase, not a test runner.
- *Test-auth primitives* (Playwright docs, `playwright-persona`, `cy.session`, Clerk, Supabase, Firebase emulator, WorkOS Emulate, Dusk `loginAs`, cypress-on-rails) solve "sign in fast as role X". Every one of them hands the test process a credential: a password, a service-role key, `CLERK_SECRET_KEY`, a shared middleware token. Playwright maintainers explicitly declined to own a persona layer (#36540) and asked for it to be built outside; the resulting package has 135 stars. Nobody mints a real session cookie server-side behind a key the test code never holds.
- *Evidence tools* (Currents, TestDino, Argos, Checkly, QA Wolf) store and display artifacts. Playwright has refused native secret masking twice: #19992 (open as "P3-collecting-feedback" since 2023, ~165 thumbs-up on comments, last comment Sep 24 2026) and #31728 (closed the day it was opened; the maintainer's reply carries 9 thumbs-down). The maintainer's suggested answer, "a standalone package that post-processes Playwright's output", is exactly the scrub/scan/leak-check, and nobody has shipped it as a product. The community is writing one-off scripts (a Sep 2026 PR in `rbeezley/myk9-platform` found the HTML report embeds per-test data as base64 zips so text scrubbers miss it; another issue found a CF Access token in every failure trace). TestDino redacts before upload (detail unverified); nothing fails a run on a hit.

**Honest "close" candidates.** `understudy` (0 stars) pairs LLM-free merge gates with an auth lifecycle and a leak guard; `msilvera-howdy/qa-agent` (0 stars, private implementation) separates browser-stage and reasoning-stage credentials and promises "no values anywhere in this repository"; WorkOS Emulate seeds users and emits codes as events. These are the right instincts at toy scale, not competitors.

**Where the kit is alone**, in order of defensibility:

1. Piece 3 + piece 2 together: a contract (OpenAPI) for a dev-only session-minting and state API, plus a broker so the runner key never reaches a worker, a browser, an environment variable or an agent. No OSS equivalent, and the cloud vendors' answer (mabl credentials, 1Password) is "keep it in our vault".
2. Piece 4 at the proxy layer: refusing prod/unlisted hosts below Playwright routing, including redirect hops, WebSockets, `context.request`, and disabling non-proxied WebRTC UDP. The only comparable features are explicitly disclaimed by Microsoft; Browser Use's default is open.
3. Piece 5's fail-closed stance: evidence staged privately, scrubbed, scanned, deleted on interruption, and the run fails on a secret value. Playwright's own position is that this is unattainable natively, which is a marketing gift if the kit ships a leak-vector conformance suite (traces, HAR, HTML-report base64 zips, a11y snapshots, console, step titles).
4. Piece 1 as *accounts*, not archetypes: "persona" in the AI-QA market means a user archetype for exploratory testing (msilvera, Momentic); one real account per persona per worker with a catalog schema is a different and unclaimed thing.

Risk to that white space: Microsoft could fold origin allowlists and secret redaction into `@playwright/test` proper (the demand is on record), and 1Password could extend Agentic Autofill to headless CI. Neither would produce a test API contract or a leak-failing evidence pipeline.

## 3. What buyers respond to (landing-page headlines, 2026)

Headlines collected or quoted via search **(2nd-hand where the site was blocked)**:

- **Coverage and flake numbers**: QA Wolf "80%+ end-to-end coverage in weeks", "0% flake rate"; Currents "automatically detects flaky tests and allows you to quarantine them". Buyers want a number and a guarantee.
- **Zero effort / zero maintenance**: Meticulous "zero-effort", "maintenance cost reduced to exactly zero"; Octomind, mabl, Autify all led with "self-healing"; Playwright's own Healer agent. The field sells the removal of test upkeep.
- **Plain English tests**: Shortest, bug0, Momentic, Magnitude (while it existed), TestDriver. Authoring friction is the stated enemy.
- **Agent-native**: Playwright CLI "token-efficient", "with SKILLS"; Argos "for teams and AI agents"; Currents/TestDino "queryable by Claude Code, Cursor, or any MCP-compatible agent"; Checkly "Copy prompt" onboarding for Claude Code. In 2026 "works with your coding agent" is table stakes on the page.
- **Credentials never reach the model**: Stagehand ("credentials never reach the model"), Browser Use (placeholders), 1Password ("raw credentials never enter the LLM context"). This is the one security claim the market already knows how to buy; nobody extends it to test *code*, *artifacts* or *network reach*.
- **Monitoring as code / tests in production**: Checkly; Clerk added production testing tokens on demand. Note the tension: half the market is proud of running against prod. The kit's "never prod" lock is a differentiator for regulated and multi-tenant products, not for everyone.
- **Pricing shapes**: credits per step (Momentic, Autify Aximo, TestSprite), per test per month (QA Wolf), per minute of hosted browser (TestDriver, Momentic), per execution (QA.tech, TestDino, Currents), per screenshot (Argos, Chromatic). OSS kits (Argos, bug0, Stagehand, Browser Use) pair a permissive core with a hosted cloud.
- **Disclaimers reveal the ceiling**: "not a security boundary" (Playwright MCP/CLI), "a convenience, not a security feature" (MCP `--secrets`), "100% security cannot be assured" (`@clerk/testing`), "we won't be able to provide a comprehensive way to hide all sensitive information" (Playwright). A product whose headline is the thing everyone else disclaims will be read as a security product; it must come with the leak-vector test suite to back it.

## 4. Features we are missing vs. the field

Concrete, each tied to something a competitor ships:

1. **Inbox/OTP adapters**: a `mail` fixture over Mailpit's REST API, Mailosaur and Mailtrap, with "latest magic link / 6-digit code for persona X" helpers (Momentic, Shortest, bug0, Mailosaur). Today the mail sink is behind the private test API only.
2. **TOTP/MFA generation** for personas with MFA enabled, secret held by the broker, code returned to the worker (mabl "Basic with MFA", Momentic `otpauth` step, Shortest `--github-code`, 1Password runtime TOTP).
3. **Session verify/refresh**: a `verifySession` probe and re-mint on expiry instead of a hard failure (`playwright-persona`, understudy's "freshness by runtime probe"). The one-hour session from the test API will bite long runs.
4. **Auth-provider adapters for the test API reference implementation**: Clerk testing tokens, Supabase admin client, Firebase emulator, WorkOS Emulate, Auth0 ROPG, Dusk `loginAs`, cypress-on-rails `app_commands`. Ship the OpenAPI contract plus at least two reference backends (e.g. Next.js/Supabase and Rails) or nobody can adopt piece 2.
5. **Local/hermetic mode**: `docker compose up` with the app, Mailpit and a Testcontainers-style disposable DB, so the kit demos without a staging cluster (WorkOS Emulate, Firebase emulator, Testcontainers).
6. **Cross-run flake history and quarantine**: FLAKES is per run; Currents and TestDino keep history, quarantine, and "last failed" re-runs. A small SQLite/JSON history plus a `quarantine` list would close most of the gap.
7. **MCP server / CLI for evidence**: let an agent query SUMMARY, COVERAGE, FLAKES, contact sheets and the scan verdict without reading files (currents-mcp, TestDino MCP, Octomind MCP, Playwright CLI skills). Also the natural place to expose `doctor` and `health`.
8. **Failure triage classification**: label failures as app bug / test bug / environment / flake with evidence excerpts, no auto-retry (Checkly Rocky, Currents, `nirarad/playwright-ai-qa-agent`). Fits the skill's triage step and keeps the "never retry to green" rule.
9. **Visual baselines**: contact sheets exist; a diff against the last green run per browser and size, or an Argos exporter, would match what visual vendors sell (Argos, Chromatic, Percy).
10. **PR surface**: a GitHub Actions workflow that posts the contact sheet, coverage table and leak-scan verdict as a check and comment (Playwright CLI "attach screenshots to pull requests", Argos PR checks, Octomind's actions).
11. **Scenario/factory DSL for the control API**: the private app's scenario call is specific to the private predecessor; a generic kit needs a declared scenario registry (cypress-on-rails scenarios and factories) with the one-call guarantee.
12. **Interactive-agent mode with the same guarantees**: when an agent explores through Playwright MCP/CLI before writing tests, route it through the same egress proxy and persona sessions, and apply the scrub to tool responses (Playwright MCP `--secrets`, Browser Use `sensitive_data`, 1Password approval). Today the kit protects written tests, not exploration.
13. **Per-action authority**: read-only vs. state-changing actions for agents with a receipt per approved write (playwright-mcp #1758, 1Password human approval). Low priority, but it is the next question security reviewers ask.
14. **Scan depth check**: confirm the scan decodes the HTML report's embedded base64 zips and trace zips, not just one level of JSON escaping (the myk9 PR found text scrubbers miss them). If it already does, say so loudly in the docs; it is a selling point.
15. **Secret entry via CDP**: `typeSecret` should be benchmarked against the `Input.insertText` workaround from #19992 so the value stays out of trace action arguments as well as step titles.
16. **Multi-tenant and mobile scope statement**: Momentic, mabl, Autify sell iOS/Android; the kit should state web-only clearly and position tenant isolation (second workspace's head, outsider) as the thing mobile tools do not test.

## 5. Public roadmaps and issues that show unmet demand

- **microsoft/playwright #19992** "Is it possible to hide secrets from trace viewer?": open since Jan 2023, P3-collecting-feedback, ~165 thumbs-up across comments, workarounds still being posted in Sep 2026 (post-processing traces breaks JSON unless only string values are redacted). Direct demand for piece 5.
- **microsoft/playwright #31728** `fillSecure()` request: closed same day, maintainer suggests a standalone post-processing package; 9 thumbs-down on the refusal. Same demand.
- **microsoft/playwright #36540** "Authentication personas": closed Jul 2025; maintainers want the layer built outside Playwright and invited "API changes that would help the library" (e.g. public `browserContext.setStorageState()` raised by vitalets). Demand for piece 1 and an opening to upstream a small hook.
- **microsoft/playwright #31108** sessionStorage in storageState: open since May 2024.
- **microsoft/playwright-mcp #1210**: users asked for origin allow/deny lists back "for network security boundaries"; restored by playwright PR #38291 but documented as not a boundary and blind to redirects. Demand for piece 4. **#1566**: password values in a11y snapshots sent to the LLM; answer was "use `--secrets`". **#1758**: "who decides what the agent may do?" closed as not planned (client's job). **#1791** (Oct 2026): redact session/grant values in tab URLs in tool responses.
- **browser-use/browser-use #5879**: default browser profile allows all hosts and leaves IP URLs unblocked.
- **Community PRs** (rbeezley/myk9-platform #2945 and #2836, dlopez2392/bis-platform #187, geeera/product-team-plugin #19): teams stopping trace uploads, decoding base64 zips in HTML reports, and finding service tokens in failure traces. These are the kit's first users.
- **Currents** "How Playwright Tests Leak Data" names traces, HAR, reporter output and fixture logs on retry as vectors; it proposes hygiene, not enforcement.
- **Checkly** has a public feedback portal (feedback.checklyhq.com) **(unreachable here)**; its changelog shows Playwright Check Suites GA (Oct 2025) and Claude Code prompt onboarding. **Momentic, QA Wolf, TestDriver, Currents**: no public roadmap found.
- **Market signal**: Octomind shut down for "lack of market validation" while selling self-healing generated Playwright; Magnitude pivoted away from testing; Shortest went dormant. "AI writes your tests" alone is not a durable OSS category; the durable OSS in this space is infrastructure (Mailpit, Testcontainers, Argos, Playwright MCP/CLI). That argues for positioning the kit as infrastructure a coding agent uses, not as another test-writing agent.

## 6. Sources

Primary (fetched):
- https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/auth.md
- https://raw.githubusercontent.com/cypress-io/cypress-documentation/main/docs/api/commands/session.mdx
- https://github.com/microsoft/playwright-mcp (README, flags, "not a security boundary")
- https://github.com/microsoft/playwright-cli
- https://github.com/microsoft/playwright/issues/19992
- https://github.com/microsoft/playwright/issues/31728
- https://github.com/microsoft/playwright/issues/36540
- https://github.com/microsoft/playwright/pull/38291
- https://github.com/microsoft/playwright-mcp/issues/1210
- https://github.com/microsoft/playwright-mcp/issues/1566
- https://github.com/microsoft/playwright-mcp/issues/1758
- https://github.com/kettanaito/playwright-persona
- https://github.com/browserbase/stagehand
- https://github.com/browser-use/browser-use (and issue #5879 via issue search)
- https://raw.githubusercontent.com/magnitudedev/magnitude/main/README.md
- https://github.com/antiwork/shortest and https://github.com/antiwork/shortest/commits/main
- https://github.com/bug0inc/qa-agent
- https://github.com/ImJongHyuk/understudy
- https://github.com/msilvera-howdy/qa-agent
- https://github.com/octomind-dev (all repos archived)
- https://github.com/testdriverai/testdriverai
- https://github.com/checkly/checkly-cli
- https://github.com/argos-ci/argos
- https://github.com/currents-dev
- https://github.com/axllent/mailpit
- https://github.com/mailhog/MailHog
- https://github.com/testcontainers/testcontainers-java and https://github.com/testcontainers/testcontainers-node
- https://github.com/shakacode/cypress-playwright-on-rails
- https://raw.githubusercontent.com/laravel/dusk/8.x/src/DuskServiceProvider.php
- https://raw.githubusercontent.com/clerk/javascript/main/packages/testing/README.md

Secondary (search snippets; vendor domain unreachable from the sandbox):
- Clerk: https://clerk.com/docs/guides/development/testing/overview, https://clerk.com/changelog/2024-04-24-testing-tokens, https://hyperping.com/blog/test-clerk-authentication-playwright
- Browser Use sensitive data: https://docs.browser-use.com/customize/sensitive-data
- Stagehand act variables: https://docs.stagehand.dev/v3/references/act.md
- 1Password Agentic Autofill: https://blog.1password.com/closing-the-credential-risk-gap-for-browser-use-ai-agents, https://siliconangle.com/2025/10/08/1password-tackles-ai-credential-risks-new-agentic-autofill-integration-browserbase/
- WorkOS testing and Emulate: https://workos.com/docs/authkit/testing, https://workos.com/blog/testing-workos-in-ci-cd
- Supabase patterns: https://mokkapps.de/blog/login-at-supabase-via-rest-api-in-playwright-e2e-test, https://www.amillionmonkeys.co.uk/blog/2025-11-06-testing-supabase-otp-playwright-database-trigger, https://getautonoma.com/blog/how-to-test-supabase-auth
- Firebase: https://github.com/nearform/playwright-firebase, https://makerkit.dev/blog/md/tutorials/programmatic-authentication-firebase-cypress
- Auth0: https://getautonoma.com/blog/how-to-test-auth0-login, https://testdouble.com/insights/how-to-test-auth-flows-with-playwright-and-next-js
- Dusk CVE: https://osv.dev/vulnerability/GHSA-chcp-g9j5-3xxx
- Momentic: https://momentic.ai/pricing, https://momentic.ai/docs/core-concepts/authentication, https://support.momentic.ai/articles/8823632368-how-do-i-log-in-with-otpauth, https://bug0.com/knowledge-base/momentic-pricing
- QA Wolf: https://www.qawolf.com/service/qa-automation-services, https://sacra.com/c/qa-wolf/, https://rywalker.com/research/qa-wolf
- Octomind shutdown: https://aiqadirectory.com/status/, https://www.testmuai.com/octomind-alternative/, https://www.stork.ai/en/octomind-cloud-and-hub
- TestDriver pricing: https://aiidelist.com/ide/testdriver
- Checkly: https://feedback.checklyhq.com/changelog/playwright-check-suites-no-more-hacks-just-tests-in-production, https://www.checklyhq.com/changelog/set-up-playwright-check-suites-with-ai/, https://gappsy.com/tools/checkly/
- Autify: https://bug0.com/knowledge-base/autify-pricing, https://pricingsaas.com/companies/autify
- mabl credentials: https://help.mabl.com/docs/mabl-credentials, https://www.mabl.com/blog/protect-sensitive-information-with-mabl-credentials, https://bug0.com/knowledge-base/mabl-pricing
- Reflect: https://www.capterra.com/p/196292/Reflect/, https://toolradar.com/tools/reflect-tests
- Meticulous: https://app.meticulous.ai/docs/concepts/architecture-overview, https://21st.dev/blog/meticulous-vs-design-bug-bot
- Currents: https://www.currents.dev, https://currents.dev/posts/playwright-avoid-data-leak, https://testdino.com/compare/currents-vs-testdino
- TestDino: https://testdino.com/compare/testmo-vs-testdino, https://docs.testdino.com/data-privacy/data-redaction.md
- Visual testing pricing: https://argos-ci.com/blog/visual-testing-pricing, https://argos-ci.com/blog/percy-vs-chromatic-vs-argos
- Mail sinks pricing: https://frontdeskreview.com/software/email-testing/mailosaur/, https://testmail.app/blog/5-best-mailtrap-email-testing-alternatives-for-developers-2026/, https://mailosaur.com/blog/mailosaur-vs-mailtrap
- QA.tech / TestSprite / Ranger: https://www.g2.com/products/qa-tech/pricing, https://www.testsprite.com/pricing, https://www.ranger.net/post/qa-automation-cost-analysis
- Playwright Agents / CLI coverage: https://testdino.com/blog/playwright-ai-ecosystem, https://www.shiplight.ai/blog/playwright-agents, https://bondaracademy.com/blog/playwright-ai-agents-review
- Leak-vector community PRs: https://github.com/rbeezley/myk9-platform/pull/2945, https://github.com/rbeezley/myk9-platform/pull/2836, https://github.com/dlopez2392/bis-platform/pull/187, https://github.com/geeera/product-team-plugin/issues/19
- Magnitude history: https://news.ycombinator.com/item?id=43796003
- Other OSS agents: https://github.com/nirarad/playwright-ai-qa-agent, https://github.com/topics/qa-agent

## 7. Could not verify

- Any vendor landing-page H1 verbatim (Momentic, QA Wolf, Checkly, mabl, Autify, Reflect, Meticulous, Currents, Chromatic, Percy): sites were DNS-blocked; headlines above are reconstructed from search snippets and the vendors' own sub-pages.
- All commercial prices: third-party and often mutually inconsistent (noted per row).
- Clerk production testing-token support date (Aug 2025) and token lifetime.
- Supabase `auth.admin.generateLink` as an E2E minting path.
- TestDino redaction details; ToolHive's container-level network policy for Playwright MCP (would be the nearest egress-guard analogue for agents).
- Checkly secrets variable type and Reflect email/SMS testing (from memory).
- Whether `playwright-persona` supports two personas in one test and per-worker accounts.
- 1Password's "never in the LLM context" claim is vendor-stated; no independent audit found.
- Momentic "$15M Series A" and QA Wolf ARR figures are from secondary coverage.
