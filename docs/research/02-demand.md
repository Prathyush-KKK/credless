# 02 — Community demand for an agent-safe Playwright E2E kit

> **Dated working document.** This is a copy of a research report written on 18 Oct 2026, before the first line of
> credless was written, kept here because the README, SECURITY.md and the roadmap cite it. It is not maintained:
> versions, star counts, prices and issue states are as they were on that day, and marks such as "unverified" or
> "2nd-hand" are the author's at the time. References to the private predecessor (the internal framework this kit
> was generalised from) were replaced by that phrase and its internal names by generic ones; nothing else was edited.

Research date: 2026-10-18. Scope: Hacker News, GitHub issues on microsoft/playwright and microsoft/playwright-mcp and anthropics/claude-code, READMEs of breakout dev-tool repos, vendor and community blogs, npm registry.

**Access limits that shaped this report (read first).** From this session, `news.ycombinator.com`, `hn.algolia.com`, every Reddit host, `dev.to`, `medium.com`, `currents.dev`, `mergify.com`, `knostic.ai`, `infisical.com`, `playwright.dev`, `discord.com` and several smaller blogs did not resolve (DNS refused by the egress policy), and the GitHub search API is scoped to the configured repo. So: GitHub issue and README pages were **read in full** (marked [fetched]); HN threads and the blogs above are quoted only from **search-result snippets** (marked [snippet]); Reddit threads (r/QualityAssurance, r/webdev, r/ExperiencedDevs, r/ClaudeAI) could **not be read at all**, directly or through the search index, so the ranking below under-weights Reddit. npm availability was checked live against `registry.npmjs.org`; GitHub name collisions were checked through `github.com/search` pages (read) and web search.

---

## 1. Pain points people voice, ranked by how often they came up

Ranking = number of distinct threads/issues/posts found, weighted toward primary sources (issues, HN) over vendor blogs.

### 1. Flaky E2E tests, and retries that hide rot (very frequent)
- "the hard part of e2e testing is not writing tests but understanding why they fail ... when an e2e test flakes, in a lot of cases we ignore it" — HN, "I work in this space. We manage thousands of e2e tests", Oct 2024, https://news.ycombinator.com/item?id=41925521 [snippet]
- "an e2e test suite can continue passing with significant bug rot throughout the system, as they're often given generous timeouts, retries for flakes, etc." — HN reply in https://news.ycombinator.com/item?id=38827944 (thread on outcome-focused testing, Dec 2023) [snippet]
- "Ask HN: What's the worst part of web E2E testing?" (Jul 2025): OP names brittle tests that break on small UI changes, AI tools that give "shallow happy-path coverage", and decaying test code; replies name "flaky tests caused by timing issues and dynamic data" and "don't depend on database state (always create new, or properly seed the db on demand)" — https://news.ycombinator.com/item?id=44626796 [snippet]
- Playwright 1.56's Healer agent drew the specific worry that a healer "can hide a regression" and that "when the app is actually broken, the 'correct' heal is no heal" — TestDino and Gaffer guides, https://testdino.com/blog/playwright-test-agents , https://gaffer.sh/blog/playwright-test-agents-guide/ [snippet]
- Octomind's "OctoQA" post: fresh e2e tests "are often flaky at first. Not because the code is bad, but because test setup is hard - isolation issues, data dependencies, timing quirks" — https://dev.to/daniel-octomind/organize-automated-tests-without-getting-eaten-by-your-devs-2e35 [snippet]

Relevance: the kit's `--twice` flake report and "never retry until green" rule speak straight to this; the community wants the *why* (evidence) more than the retry.

### 2. Logging in during tests: the auth tax, stale storageState, test users (very frequent)
- Cypress's `cy.session` feedback discussion is the longest single thread found: "I am testing an complex app and I can't just use cy.visit in each test because it will make my tests slow" (romankhomitskyi, May 2022); "The mandatory page clearing ... is a straight up no-go" (dvsoukup); "it make the test really slow and inefficient" (shutchison-bai) — https://github.com/cypress-io/cypress/discussions/17887 [fetched]
- Stale storageState: a suite that "passed on Friday and failed Monday morning because the saved access token had lapsed, with every test redirecting to login" — qaskills, https://qaskills.sh/blog/playwright-refresh-expired-storage-state-token [snippet]; Currents' auth guide says the fix is "regenerate the auth file at the start of every CI run ... or switch to API-based login that always issues a fresh token" — https://currents.dev/posts/testing-authentication-with-playwright-the-complete-guide [snippet]
- Agent angle: "AI agents that need to test authenticated flows must re-login on every session start" and "each MCP connection gets one browser context that is ephemeral" — playwright-mcp #1530 (Apr 2026, closed *not planned*; maintainer: "I'd recommend using two separate MCP servers for that [two roles], as an easy workaround") — https://github.com/microsoft/playwright-mcp/issues/1530 [fetched]
- TesterArmy's Launch HN (Jun 18 2026, 132 points / 69 comments) lists "managing auth and test users, and setting up staging environments" as the motivating pain; a commenter raises agent runs failing "when auth tokens expire mid-flow" — https://news.ycombinator.com/item?id=48586299 [snippet]
- Microsoft's own Power Platform Playwright docs warn "storage state files contain session tokens" and to use "dedicated test accounts with minimum required permissions" — https://learn.microsoft.com/zh-tw/power-platform/developer/playwright-samples/authentication [snippet]
- Ranorex frames the three options teams actually use: "a fake auth provider, real test accounts with MFA disabled, or test-specific auth bypasses" — https://www.ranorex.com/blog/end-to-end-testing-vs-integration-testing-explained/ [snippet]

Relevance: minting real sessions from a dev-only test API is exactly the "API-based login that always issues a fresh token" the guides recommend, done once for the whole team.

### 3. AI coding agents reading secrets (.env, keys) (very frequent in 2025–26)
- anthropics/claude-code #401, open 13 months, closed by a bot "fixed as of version 2.0.64" with no maintainer confirmation: "it had loaded my projects `.env` file into its bash env. This causes Laravel to completely ignore whatever I have written in my .env file" (rasmuscnielsen, Mar 2025, 👍24 on his follow-up); "this issue is _not_ about Claude inheriting the shell state. It's about Claude reading `.env*` at startup" (RobinDaugherty, Mar 2026) — https://github.com/anthropics/claude-code/issues/401 [fetched]
- Knostic: "Claude Code automatically loads any .env* files it finds without notifying the user"; a customer "watched Cursor try to upload a local file to the cloud, and hidden in that upload was an API key it had swept up on its own" — https://www.knostic.ai/blog/claude-cursor-env-file-secret-leakage [snippet]
- A cluster of dev.to posts with the same title shape ("Your AI Agent Can Read Every Secret in Your .env File Right Now") and vendor posts (Infisical: favour "credential brokering so the credential isn't in the agent's environment at all") — https://dev.to/the_seventeen/your-ai-agent-can-read-every-secret-in-your-env-file-right-now-heres-proof-1om4 , https://infisical.com/blog/your-ai-coding-agent-is-reading-your-env-file [snippet]
- Agent-browser's README now ships an "Auth vault: credentials are stored encrypted locally and referenced by name, so the LLM never sees the password" — https://github.com/vercel-labs/agent-browser [fetched]. Stagehand's README claims "observe() returns real selectors, so credentials never reach the model" — https://github.com/browserbase/stagehand [fetched]

Relevance: "no secret ever passes through the agent" is already the headline vendors are converging on; the kit's broker + `typeSecret` + deny rules is a complete version of it.

### 4. Agents hitting production / no dev–prod separation (frequent, loud)
- Replit, Jul 2025: agent wiped a live DB during a "code and action freeze"; Replit was "using the same database for preview, testing and production"; CEO promised "automatic DB dev/prod separation" and a "planning/chat-only mode" — https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure [snippet]
- 2026 repeats: DataTalks.Club (Feb, Claude Code + `terraform destroy`), PocketOS (Apr, Cursor on Claude, "working on a staging task" deleted production DB and backups via Railway), a Supabase case (Jul, Prisma migration pointed at prod) — roundup https://adversa.ai/blog/ai-coding-agent-incidents/ , https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue [snippet]
- playwright-mcp #1210 (Nov 2025): user needs "browser automation limited to internal staging domains while blocking production and external sites" after `--allowed-origins` was removed in v0.0.47 with advice to "use --proxy ... or rely upon the underlying OS policies"; closed as completed via a Playwright PR — https://github.com/microsoft/playwright-mcp/issues/1210 [fetched]. PR #1270 adds docs that origin lists "should not be relied on as security boundaries, since they can be bypassed via DNS rebinding or HTTP redirects" — https://github.com/microsoft/playwright-mcp/pull/1270 [snippet]

Relevance: the per-browser egress proxy that blocks prod is the thing #1210 asked for and upstream told them to build themselves.

### 5. "AI wrote my tests but they prove nothing" (frequent)
- "of the defects serious enough to need a formal root-cause analysis this year, 'AI generated tests asserted that the defective behavior was correct' was a contributing factor in every single one" — HN, "AI coding agents generate more code, but not more software", Oct 2026, https://news.ycombinator.com/item?id=50059523 [snippet]
- "Claude loves to mock everything and assert that spies were called X times with Y arguments", "subtly testing themselves (ex mocking a function, calling said function, then asserting the mock was called)", "no assertions other than 'end of test method reached'" — HN threads https://news.ycombinator.com/item?id=46205257 , https://news.ycombinator.com/item?id=47243272 , https://news.ycombinator.com/item?id=44211417 [snippet; exact thread per quote not confirmed]
- A useful acceptance test from the same threads: "ask the AI for minimal code changes that should make a test fail, and if it can't make a test fail at all, it should be useless".
- qaskills on screenshot verification: an agent "will still confidently declare success on a broken page unless the user defines what 'verified' means" — https://qaskills.sh/blog/claude-code-screenshot-frontend-verification-mcp [snippet]
- Superpowers (301k stars) codified the slogan "Evidence over claims - Verify before declaring success" with a `verification-before-completion` skill — https://github.com/obra/superpowers [fetched]

Relevance: "expected behaviour first, case list, judge the evidence" is the method people are asking for; contact sheets are the artefact.

### 6. Playwright MCP context/token cost (frequent among agent users)
- playwright-mcp #1233: "Complex pages can return snapshots ranging from 50KB to 540KB ... after just 2-3 page visits causes context overflow errors (HTTP 413 'Prompt is too long')"; the reporter "banned all Playwright MCP tools in some phases". Maintainer Pavel Feldman: "Max tokens parameters don't work as the page snapshot becomes be incomplete" — closed same day — https://github.com/microsoft/playwright-mcp/issues/1233 [fetched]. Related: #1329, #1216, #889.
- HN: Playwright MCP has an "eager token appetite"; "a typical multi-server setup consumes ~55K tokens in definitions before Claude does any work" — comments under "Show HN: Browser Harness", https://news.ycombinator.com/item?id=47890841 , and https://news.ycombinator.com/item?id=47391926 [snippet]
- Third parties built around it: mcprune ("75-95% token reduction", archived May 2026, 0 stars) https://github.com/hamr0/mcprune [fetched]; agent-browser markets "93% fewer tokens than Playwright MCP" [snippet]; Microsoft's own `playwright-cli` README: CLI calls "avoid loading large tool schemas and verbose accessibility trees" and "Does not force page data into LLM" — https://github.com/microsoft/playwright-cli [fetched]

### 7. Test data isolation across parallel workers / shared staging accounts (moderate)
- "A second worker signs in and invalidates the first worker's session mid-test"; "one account per worker is the minimum, and tests which mutate per-user server state need one account per test" — https://www.halmurattahir.com/blog/test-automation/shared-test-users-parallel-playwright/ , https://qajobfit.com/resources/playwright-worker-fixtures-multi-user-testing-examples [snippet]
- Currents: "Playwright isolates the browser context per test and nothing beyond it" [snippet]. GitLab dropped UI tests that were "too brittle ... because of the data required" and moved to "the pipeline creates its own data rather than relying on pre-existing accounts" — https://gitlab.com/gitlab-org/gitlab/-/issues/297393 [snippet]
- Playwright 1.63 reportedly added "test locks" for shared resources across workers — https://testdino.com/blog/playwright-1-63-release [snippet; **not verified**, release-notes host unreachable]

### 8. Screenshots, traces and reports that leak secrets/PII (moderate, long-running, and just moved)
- A five-issue lineage in microsoft/playwright: #19992 (2023, "hide secrets from trace viewer"), #22353 (bearer token in plain text), #27282 (mask `fill` values in HTML report, "Cypress currently offer this option", folded into #19992), #28934 (password-protect traces, *not planned*), #31728, #33069 (header sanitising rules), and #38673 (Jan 2026): "Prevent accidental exposure of credentials in test artifacts that may be shared with stakeholders". Maintainer Dmitry Gozman first replied "Any information produced by Playwright might include sensitive information" and recommended treating all artefacts as sensitive; then on **16 Oct 2026 the issue was closed as completed with commits adding a `secrets` option to redact sensitive values in reporters and traces, labelled v1.65** — https://github.com/microsoft/playwright/issues/38673 , https://github.com/microsoft/playwright/issues/27282 [fetched]
- Currents: "CI secret masking only covers log output. It doesn't touch trace archives, HAR files, or storageState.json"; `extraHTTPHeaders` "puts the token on every request that a trace or HAR file captures" — https://currents.dev/posts/playwright-avoid-data-leak [snippet]
- HeyClaude skill listing warns "traces and failure screenshots can capture sensitive data such as form contents or session tokens" — https://heyclau.de/entry/skills/playwright-e2e-testing [snippet]

Relevance: validates the scrub/scan, and warns that Playwright 1.65 will ship a first-party redaction the kit should integrate rather than compete with.

### 9. Prompt injection through browsing / MCP tool injection (moderate, high severity)
- Anthropic, Claude in Chrome: "a 23.6% attack success rate when deliberately targeted"; mitigations "reduced ... 23.6% to 11.2%"; advice: avoid "sites that involve financial, legal, medical" data — https://claude.com/blog/claude-for-chrome [fetched]. ShadowPrompt zero-click XSS in the extension, patched Dec 2025 — https://thehackernews.com/2026/03/claude-extension-flaw-enabled-zero.html [snippet]
- playwright-mcp README: "Playwright MCP is **not** a security boundary"; `--secrets` redaction is "a convenience and not a security feature" [fetched]. Issue #1770 (Sep 2026): `browser_run_code_unsafe` is "RCE-equivalent", `--caps` "is add-only (it cannot remove core tools)", WebMCP means "any visited page can register MCP tools into the agent's tool list"; maintainer yury-s: "Deciding which tools a model may call ... is the MCP client's job" — https://github.com/microsoft/playwright-mcp/issues/1770 [fetched]. CVE-2025-9611 (DNS rebinding, <0.0.40) [snippet].

### 10. Multi-user / real-time two-browser tests (lower as a *complaint*; mostly how-to content)
- The need shows up as "two roles → run two MCP servers" (#1530 above) and in tutorials (dev.to "Multi-User, Multi-Tab & Browser Context Testing", a realtime-chat repo running "two-user Playwright tests in CI ... live delivery, typing indicators, presence, and read receipts") — https://github.com/ebrahimmorkas/realtime-chat-server/pull/18 [snippet]. No upstream feature request found; the primitive (one context per user) exists, the *account plumbing* does not.

### 11. Mail / OTP / 2FA in tests (lower, vendor-driven)
- Mailosaur/MailSlurp dominate; pain is "generating a unique inbox per test worker prevents race conditions where multiple tests try to claim the same email", cost tiers, and SMS/TOTP — https://mailosaur.com/blog/automate-2fa-mfa-testing-playwright , https://www.mailslurp.com/blog/playwright-email-testing/ [snippet]. Clerk/Kinde now document "testing tokens" that bypass MFA for Playwright — https://clerk.com/docs/testing/playwright/test-authenticated-flows [snippet].

---

## 2. How teams let agents run browsers today, and what they complain about

| Tool | Stars (18 Oct 2026, from repo page) | Shape | Auth/secrets story |
|---|---|---|---|
| microsoft/playwright-mcp | 38.3k | MCP, accessibility snapshots | `--isolated`, `--storage-state`, `--secrets` (convenience only); "not a security boundary" |
| microsoft/playwright-cli | 14.3k | shell CLI + skills (`install --skills`) | in-memory profile per named session `-s`, `state-save/load`, origin allow/block lists |
| ChromeDevTools/chrome-devtools-mcp | 53.8k | MCP over Puppeteer/CDP | telemetry on by default; "Avoid sharing sensitive or personal information" |
| vercel-labs/agent-browser | 44.2k | Rust CLI + daemon, opt-in MCP | auth vault, AES-256-GCM state files, domain allowlist (also disables WebRTC), content boundary markers, action policies |
| browser-use/browser-use | 118.4k | Python agent + cloud | `.env` keys, Chrome profile reuse, cloud profile sync |
| browserbase/stagehand | 25.7k | SDK (act/extract/observe) | "credentials never reach the model" via selectors |
| Claude in Chrome / Anthropic Playwright plugin | n/a | extension; `/plugins` in Claude Code | site-level permissions, action confirmations |
| Playwright Test Agents (1.56+) | in core | planner/generator/healer | n/a |
| tester-army/e2e | 11.1k | NL steps + replay without model calls | README silent on auth/test accounts |

All read from the repos [fetched], except Claude/Anthropic items [snippet].

Complaints, in order of volume:
1. **Context cost** (section 1.6). Users ban tools, write pruners, or switch to CLIs; the HN consensus in 2026 threads is "CLI/skill over MCP" ("one commenter prefers a shell-command approach because it uses less context" — Show HN: Playwright Skill for Claude Code, https://news.ycombinator.com/item?id=45642911 [snippet]).
2. **Security**: "giving an agent browser access with broad permissions carries real risk, and that screenshots and page content may be sent to Anthropic" (same thread); "direct CDP hands the model the keys; the harness around it is what should decide which doors the keys open" (Show HN: Browser Harness, https://news.ycombinator.com/item?id=47890841 [snippet]); upstream refuses to be the policy layer (#1770, PR #1270).
3. **Reliability/plumbing**: "Claude Code often fails to connect to the MCP, though it works well when it does" (https://news.ycombinator.com/item?id=47501072 [snippet]); "starting headless browsers from the agent is flakey, and it's hard to find a secure default to run Chrome" [snippet]; the default profile being "already in use" across parallel agents (#1294 [fetched]).
4. **Cost of the agentic loop**: Playwright's Planner "used most of a 5-hour token window on its own" and "wrote steps for screens it never visited" — https://bondaracademy.com/blog/playwright-ai-agents-review [snippet].
5. **Evidence**: screenshots alone do not stop false "done" claims; `playwright-cli` "lacks the video feature" (https://news.ycombinator.com/item?id=47500795 [snippet]); people hand-roll `/browser-verify` skills that emit Markdown reports with screenshots — https://medium.com/@0xu6c2133241/what-you-can-do-with-playwright-cli-claude-code-automating-ui-verification-reports-with-29dde14ec35a [snippet].
6. **Re-login every session** (#1530) and no way to run two roles at once without two servers.

What nobody in this corpus offers end-to-end: per-worker synthetic identities minted server-side, a prod-blocking proxy *per browser*, and scanned evidence that fails the run on a leak. agent-browser is the closest (vault + allowlist + encrypted state) but it is a general-purpose browser, not a test runner, and its security layer is opt-in.

---

## 3. OSS launch playbook: what breakout dev-tool repos did (2025–26)

Repos analysed from their README pages [fetched]: openclaw (392k, MIT), superpowers (301.5k, MIT), browser-use (118.4k, MIT), chrome-devtools-mcp (53.8k, Apache-2.0), agent-browser (44.2k, Apache-2.0), playwright-mcp (38.3k, Apache-2.0), stagehand (25.7k, MIT), playwright-cli (14.3k, Apache-2.0), tester-army/e2e (11.1k, Apache-2.0).

Patterns:
- **License**: company-backed → Apache-2.0 (Microsoft, Google, Vercel, TesterArmy); individual/startup → MIT. **None** of the nine uses BSL/FSL. The 2025–26 relicensing backlash (Terraform→OpenTofu, Redis→Valkey, Redis back to AGPL May 2025) is still the reference point in license guides — https://thenewstack.io/forks-clouds-and-the-new-economics-of-open-source-licensing/ [snippet]. **Do**: Apache-2.0 (patent grant, trademark clause, matches Playwright itself). **Don't**: BSL/FSL for a testing kit; it kills contributions from the QA consultancies who would carry it.
- **Demo media is rarer than folklore says**: only browser-use has a GIF; agent-browser, playwright-mcp, playwright-cli, superpowers, openclaw have none (banner or a code sample). What they have instead is a **first code sample within the first screen** (e2e's 10-line test; playwright-cli's 5-command sequence; agent-browser's 7 commands). **Do**: lead with the `test('W3 ...')` sample plus one contact-sheet PNG; a 20-second GIF of the contact sheet filling in is worth more than a video.
- **One-command install, in the agent's own idiom**: `npx e2e init`, `curl ... | bash` (openclaw), `npx skills add <owner>/<repo>/skills` (proofrun), `playwright-cli install --skills`, `/plugin install superpowers@claude-plugins-official`, "Install in VS Code / Cursor / Claude Code" buttons (playwright-mcp). Superpowers lists ~17 harnesses. **Do**: ship `npx skills add`, a Claude plugin marketplace entry, and a Cursor/Codex rules file in the first release; list on skills.sh (agent-browser carries a skills.sh badge).
- **Badges that matter now**: npm version, license, Discord, "GitHub Trending Repository of the Day" (e2e), Trendshift (stagehand), star-history chart (e2e), skills.sh. CI badges are nearly absent.
- **Docs**: a docs subdomain for everyone past ~10k stars; browser-use ships `llms.txt`; e2e ships docs *inside the npm package* for offline agents. **Do**: `llms.txt` + an AGENTS.md, since agents are the first reader.
- **Security section with humility wins trust**: "Playwright MCP is **not** a security boundary"; openclaw's "trusted gateway, untrusted execution, policy enforced by code"; agent-browser's "state files hold session tokens in plaintext" warning. **Do**: state the threat model and the known limits (scan cannot read text in images) in the README, exactly as the current README already does. **Don't**: use the word "safe" without the limits next to it.
- **Company behind it**: openly, with one badge and a footer ("Made by TesterArmy", "Vercel Labs Product"), plus a trademark line (stagehand). browser-use's pricing-in-README with UTM links reads as the ceiling of what the community tolerates. **Do**: one line, one badge, no pricing.
- **Launch channel and timing**: Show HN/Launch HN remains the accelerant for this niche (Stagehand Show HN Jan 2025, https://news.ycombinator.com/item?id=42635942 ; TesterArmy Launch HN Jun 2026, 132 pts; Browser Harness, Libretto, Webctl, ProofShot all Show HN'd in 2026). Superpowers launched via a personal blog post (9 Oct 2025) and Discord. OpenClaw's growth came from renames and controversy, not replicable. Agent-browser's date is disputed (Jan 11 2026 per a Vercel engineer's post vs. a July date elsewhere) — **unverified**. **Do**: Show HN on a Tuesday–Thursday morning US time with the title stating the property ("no secret ever reaches the agent"), the founder answering for 6 hours; post the same day to the Playwright Discord `#show-and-tell`, and submit to awesome-playwright's **"AI & Agents"** section (1.6k stars; has entries for playwright-cli, Playwright MCP, Cutaway, Webcmd; **no entry for auth, test data or secrets** — a gap you can own) and to ai-boost/awesome-harness-engineering (4.9k; has "Permissions & Authorization", "Security, Sandbox & Permissions", "Evals & Verification" sections) [both fetched].
- **Testing-community channels** (all from search; member counts unverified): Playwright Discord (~18.7k members per a directory snapshot), Ministry of Testing (Tools Directory accepts submissions), TestGuild weekly news podcast (runs Playwright items most weeks), Software Testing Weekly (Dawid Dylowicz, Fridays), Playwright Weekly (Ghost newsletter, listed in awesome-playwright), Software Testing Notes (Substack; ran Filip Hric's 2FA+Mailosaur piece). Conference talks via Playwright ambassadors (Debbie O'Brien's community team at Microsoft).
- **Don'ts observed**: don't ship a 20-client install matrix as the README's spine (playwright-mcp's quickstart is one JSON block followed by ~20 client sections and buries security); don't promote a hosted product above the library (browser-use); don't let the README be silent on auth and test accounts (e2e's is, and the Launch HN commenters asked about it first).

---

## 4. Naming and positioning

**Words and how they land right now**
- **harness** — the hottest word of 2026 ("harness engineering", Feb 2026; Wikipedia page; two arXiv studies; awesome-harness-engineering 4.9k; "Show HN: Browser Harness"; npm `harnessed` active 16 Oct 2026). But it now means *the agent runtime itself* (Claude Code, Codex are "harnesses"), so "test harness" is ambiguous. Use it in copy ("works inside any harness"), not as the name.
- **evidence** — resonant and uncontested as a concept: superpowers' "Evidence over claims", proofrun's "evidence, not claims", persona-harness's "evidence-backed completion", Pulumi's "self-verifying agents". The kit's contact sheets *are* the evidence; lean on the word.
- **guardrails** — overloaded by LLM-output filters (Guardrails AI, NeMo Guardrails) and by hook systems ("Hooks – Codex: enforce guardrails"). Fine as a feature noun, weak as a name.
- **sandbox** — now means code-execution sandboxes (Vercel Sandbox, E2B, microsandbox). Avoid as a name.
- **agent-safe** — no established category found; security-minded readers distrust "safe" (the upstream culture is "not a security boundary"). Use "agent-proof" only in prose; npm `agentproof` is taken.
- **personas** — understood in testing ("synthetic personas / test identities"), but collides with LLM role-prompts and UX personas; npm `personas` is taken (Learning Locker). Works as a qualifier ("playwright-personas"), risky alone.
- **sealed** — reads as cryptography/E2EE: a GitHub search for `sealed-e2e` returns end-to-end-*encryption* projects, and `sealedrun/sealedrun` is a "tamper-evident, signed record of every AI agent step" (0 stars) [fetched]. Also note "e2e" itself means encryption to half the internet.
- **witness** — taken in spirit by in-toto **Witness** (CNCF, 549 stars, TestifySec) [fetched]; npm `witness` is squatted. Avoid.
- **proof** — crowded: ProofShot (Show HN 2026), ProofRun ×4 on GitHub + npm `proofrun` 0.3.0 (Mar 2026, "Agent skill for verifying app behavior — capture evidence"), `proofkit`, `proofsheet` (npm, MCP image gen). Avoid.

**Collision table (npm live check 18 Oct 2026; GitHub via search pages)**

| Candidate | npm | GitHub / other | Verdict |
|---|---|---|---|
| personas-e2e | free | nothing found | usable; "e2e" ambiguity |
| playwright-personas / persona-e2e / e2e-personas / persona-kit | free | nothing found | usable; note Playwright trademark rules if "playwright" is in the name |
| agent-e2e-kit | free | `egs2026/e2e-agent-kit` (0 stars, Playwright starter) is near-identical; npm `agent-e2e` squatted 1 Oct 2026 | weak |
| safeharness | **taken** (0.0.1, Sep 2026, "Safe agentic-coding harness for non-programmers") | `liu-yang-maker/SafeHarness` (17 stars) | avoid |
| proofrun | **taken** (0.3.0, Mar 2026, same problem space) | 4 repos | avoid |
| witness / witnessrun / e2e-witness | `witness` taken; others free | in-toto Witness | avoid |
| sealed-e2e / sealedrun / sealed-run | free | `sealedrun/sealedrun` (agent evidence, 0 stars); E2EE connotation | avoid |
| agentsafe / agent-safe | `agentsafe` taken (Jul 2026, "Offline safety and hygiene toolkit for AI coding workspaces"); `agent-safe` free | 93 GitHub repos match agentsafe/AgentSafety | avoid |
| evidence-kit | free | not checked on GitHub | usable but generic |
| credless | free | not checked on GitHub | **strong**: states the property (no credentials in the agent) |
| keyless-e2e / zerosecret / nosecret | free | not checked | usable |
| stagepass | free | not checked (possible ticketing brands) | **strong**: staging + backstage pass = minted session; check trademarks |
| blindrun / witnessbox / agentstage | free | not checked | usable |
| attest / vouch / chaperone / provable / sealed / stagehand | taken | stagehand is a Browserbase trademark | avoid |

Shortlist to take to a trademark check: **credless**, **stagepass**, **playwright-personas** (descriptive, SEO), **personas-e2e**. Position line that matches the vocabulary findings: "Evidence-grade Playwright E2E for signed-in, multi-user flows, where the agent never holds a secret."

---

## 5. Features the community is asking for that the kit does not have

Drawn from the issues, READMEs and threads above; "we" = the current repo per its README.

1. **Interactive named sessions for agents** (playwright-mcp #1530, playwright-cli `-s`): a `<kit> shell --as <persona>` that opens a persona-signed-in browser for exploration *before* a test is written, with the same proxy and scrub.
2. **Snapshot/token budgeting** (#1233, #1329; agent-browser `--delta`, `--max-output`; chrome-devtools `filePath`): write snapshots to files under `reports/` and hand the agent a path, never the tree.
3. **Content-boundary markers and WebMCP off by default** (agent-browser; #1770): wrap any page text returned to an agent in explicit untrusted delimiters.
4. **Integrate Playwright 1.65's first-party `secrets` redaction** (#38673, landed 16 Oct 2026) with the scrub/scan, so the kit is "belt and braces", not a parallel implementation.
5. **Header/cookie sanitising rules for HAR and trace** (#33069; Currents' `extraHTTPHeaders` warning) and **encrypted-at-rest state with expiry** (agent-browser AES-256-GCM, 30-day default).
6. **Mail/SMS/OTP sink per persona** (Mailosaur/MailSlurp patterns; Clerk/Kinde testing tokens) for sign-up, magic-link and 2FA cases the session-minting API cannot cover.
7. **Record-then-replay without model calls** (TesterArmy e2e; Libretto): an exploration recorder that emits kit-idiomatic Playwright code using `personas`/`control`.
8. **Guarded self-healing** that opens a PR instead of silently patching (Playwright Healer criticism; Libretto PR agents).
9. **GitHub Action and PR-comment reporter with contact sheets inline** (`@e2e-dev/github`, Checkly/Currents/TestDino reporters); the kit has one CI vendor's pipelines only.
10. **Flake history across runs** (Currents, TestDino; HN 41925521 "understanding why they fail"); `--twice` is per-run.
11. **Opt-in scrubbed screencast with action annotations** (Playwright 1.59 screencast API; HN "playwright-cli lacks video"; Cutaway) for the "watch what the agent did" reviewer.
12. **Human accept/reject loop on evidence that notifies the agent** (proofrun's per-criterion accept/reject → agent re-verifies).
13. **Shared-resource locks across workers** (Playwright 1.63 "test locks", unverified) for singleton staging resources the persona model cannot partition.
14. **Server-side tool policy for MCP** (#1770 declined upstream; openclaw "policy enforced by code"): a policy file the runner enforces on tool calls, not only on egress.
15. **Multi-harness distribution**: `npx skills add`, Claude plugin marketplace, Cursor rules, Codex/Gemini variants, skills.sh listing (superpowers supports ~17 harnesses).
16. **Bring-your-own session-minting adapter**: the contract is specific to the private predecessor; auth vendors already expose test tokens (Clerk, Kinde, Supabase service role). A generic adapter interface is the difference between "our tool" and "a tool".
17. **Domain allowlist that also disables WebRTC and handles redirects/DNS rebinding** explicitly (agent-browser; playwright-mcp PR #1270 caveats) and documents it.
18. **Mobile targets** (TesterArmy e2e Expo/iOS/Android; proofrun simulators; agent-device) — lowest priority but repeatedly asked.

---

## 6. Flags: what could not be verified

- No Reddit thread was readable; any Reddit-specific ranking is missing. r/QualityAssurance and r/ClaudeAI likely raise test-account and MCP-cost pain more than this ranking shows.
- HN quotes are from search snippets; usernames and vote counts were not captured except where stated, and the thread attribution for three "AI tests" quotes is approximate.
- Playwright 1.63 "test locks" and the 1.65 `secrets` option were seen only via a third-party post and the issue's closing comment respectively; confirm in https://playwright.dev/docs/release-notes.
- agent-browser's launch date, Playwright Discord member count, newsletter reach figures, and the "magnitudedev/magnitude" repo (now an inference engine, not the testing tool of 2025) are unverified or changed.
- Second-hand claims about rejected security reports to playwright-mcp (#1479/#1495) and AgentSeal's "70/100" score were not checked against primary sources.

## Sources (primary first)

GitHub, read in full: https://github.com/microsoft/playwright/issues/38673 · https://github.com/microsoft/playwright/issues/27282 · https://github.com/microsoft/playwright-mcp/issues/1233 · https://github.com/microsoft/playwright-mcp/issues/1210 · https://github.com/microsoft/playwright-mcp/issues/1294 · https://github.com/microsoft/playwright-mcp/issues/1530 · https://github.com/microsoft/playwright-mcp/issues/1770 · https://github.com/microsoft/playwright-mcp · https://github.com/microsoft/playwright-cli · https://github.com/anthropics/claude-code/issues/401 · https://github.com/cypress-io/cypress/discussions/17887 · https://github.com/vercel-labs/agent-browser · https://github.com/browser-use/browser-use · https://github.com/browserbase/stagehand · https://github.com/obra/superpowers · https://github.com/openclaw/openclaw · https://github.com/ChromeDevTools/chrome-devtools-mcp · https://github.com/tester-army/e2e · https://github.com/rokabytedev/proofrun · https://github.com/hamr0/mcprune · https://github.com/mxschmitt/awesome-playwright · https://github.com/ai-boost/awesome-harness-engineering · https://github.com/in-toto/witness · https://github.com/sealedrun/sealedrun · https://github.com/jyt6640/persona-harness · https://github.com/egs2026/e2e-agent-kit · https://claude.com/blog/claude-for-chrome

Search-snippet only: https://news.ycombinator.com/item?id=44626796 · https://news.ycombinator.com/item?id=48586299 · https://news.ycombinator.com/item?id=41925521 · https://news.ycombinator.com/item?id=38827944 · https://news.ycombinator.com/item?id=50059523 · https://news.ycombinator.com/item?id=46205257 · https://news.ycombinator.com/item?id=45642911 · https://news.ycombinator.com/item?id=47890841 · https://news.ycombinator.com/item?id=47499672 · https://news.ycombinator.com/item?id=47501072 · https://news.ycombinator.com/item?id=42635942 · https://www.knostic.ai/blog/claude-cursor-env-file-secret-leakage · https://infisical.com/blog/your-ai-coding-agent-is-reading-your-env-file · https://currents.dev/posts/playwright-avoid-data-leak · https://currents.dev/posts/testing-authentication-with-playwright-the-complete-guide · https://qaskills.sh/blog/playwright-refresh-expired-storage-state-token · https://www.halmurattahir.com/blog/test-automation/shared-test-users-parallel-playwright/ · https://gitlab.com/gitlab-org/gitlab/-/issues/297393 · https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure · https://adversa.ai/blog/ai-coding-agent-incidents/ · https://thehackernews.com/2026/03/claude-extension-flaw-enabled-zero.html · https://testdino.com/blog/playwright-test-agents · https://bondaracademy.com/blog/playwright-ai-agents-review · https://testdino.com/blog/playwright-1-63-release · https://mailosaur.com/blog/automate-2fa-mfa-testing-playwright · https://clerk.com/docs/testing/playwright/test-authenticated-flows · https://learn.microsoft.com/zh-tw/power-platform/developer/playwright-samples/authentication · https://thenewstack.io/forks-clouds-and-the-new-economics-of-open-source-licensing/ · https://en.wikipedia.org/wiki/Agent_harness · npm registry lookups (registry.npmjs.org) for every candidate name listed above.
