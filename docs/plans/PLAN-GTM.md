# Go-to-market plan: credless

> **Dated working document.** This is a copy of a go-to-market plan written on 18 Oct 2026, before the first line of
> credless was written, kept here because the README, SECURITY.md and the roadmap cite it. It is not maintained:
> versions, star counts, prices and issue states are as they were on that day, and marks such as "unverified" or
> "2nd-hand" are the author's at the time. References to the private predecessor (the internal framework this kit
> was generalised from) were replaced by that phrase and its internal names by generic ones; nothing else was edited.

Date: 18 Oct 2026. Inputs: the four research reports in `../research/` (01 competitors, 02 demand, 03 tech,
04 security) and the private predecessor's README. Market facts come from those reports; name facts from checks run today.

In one sentence: **publish the kit as `credless`, position it as test infrastructure a coding agent uses (not an AI
that writes tests), lead with the property the market already buys ("the credential never reaches the agent")
stated precisely, and back it with a published threat model and a leak-vector test suite before the first post.**

---

## 1. Name

### Recommendation: `credless`

Pronounced "cred-less". It names the property the way the industry already names patterns ("passwordless",
CyberArk's "Secretless Broker"): a security reader hears "the long-lived credential sits outside the trust
boundary", not "nothing can ever leak". It reads well everywhere: `credless init`, `credless run --target staging`,
`npx credless init`, `@credless/playwright`, `@credless/adapter-clerk`, "a credless run". It does not say "safe" or
"secure"; the README's first security sentence defines it so nobody reads it as absolute: *credless means the
agent, the test code and the evidence run without the credential: no long-lived key, password or service token is
given to them; what they hold is a short-lived session for a synthetic account, and we say exactly what that is.*
Known weakness: "cred" also means credibility; expect one HN joke and own it in the FAQ.

### Fallbacks

1. **`dramatis`** (*dramatis personae*, the cast list): free on npm; the GitHub user is a Ruby actor library dead
   since 2010; nothing live in dev tools. Distinctive, fits the persona catalog, but does not state the property.
2. **`stagepass`** (staging + backstage pass = a minted session): free on npm, the stronger metaphor, but crowded
   on GitHub (116 repos, 9 named exactly `stagepass`, a private org holds the name). Usable; expect SEO competition.

### Availability checks (all run 18 Oct 2026)

Sources: `registry.npmjs.org/<name>`, `github.com/<name>`, `api.github.com/search/repositories?q=<name>`, web
search for a live product or mark.

| Candidate | npm (unscoped) | GitHub user/org | GitHub repos | Product / trademark | Verdict |
|---|---|---|---|---|---|
| **credless** | free (404) | user `credless`: dormant personal account, 1 unrelated repo; `credless-dev` free | 3 hits, none exact, none in testing | none found (only the archaic word "creditless"). `@credless` scope: 0 packages; ownership not verifiable without login (401/403) | **recommend** |
| dramatis | free (404) | user `dramatis`: Ruby actor lib, last push 2010 | 103 hits, 3 exact, none active dev tools | none (Dramatify/Dramatica are film software, different name) | fallback 1 |
| stagepass | free (404) | org `stagePass` exists (private) | 116 hits, 9 exact; two small dev tools, creator and ticketing apps | "StagePass" iPhone music app (old); "Backstage Pass" marks in other classes | fallback 2 |
| playwright-personas | free | n/a | **exact repo exists** (`RyanCollinsAI/playwright-personas`, multi-account toolkit, Aug 2026); `kettanaito/playwright-persona` 135 stars | "Playwright" is a Microsoft mark | reject |
| personas-e2e | free | n/a | none exact | "e2e" reads as encryption to many | usable, generic |
| keyless-e2e | free | n/a | none exact | npm `keyless` taken (2013) | usable, same e2e problem |
| evidence-kit | free | n/a | 3 exact repos | generic | reject |
| witnessrun | free | n/a | n/a | in-toto Witness (CNCF) owns the word | reject |
| stuntdouble | free (404) | user exists | 6 exact; `stunt-double/stuntdouble-mcp` is live Claude Code/Cursor tooling (Oct 2026) | none | reject |
| nocred | free (404) | user `Nocred` (empty) | 2 exact, unrelated | none | usable, unlovely |
| stagedoor | free (404) | org is a London theatre company | 13 hits | live company | reject |
| castkit, understudy, standin, rehearsal, playbill, greenroom | castkit free; the rest taken (abandoned 2014–2016) or an unpublished stub | `ImJongHyuk/understudy` is an OSS test harness | | | reject |

Paths to reserve now (reserve; do not buy a domain yet):

- GitHub: `github.com/Prathyush-KKK/credless` first (the founder's account); create the org **`credless-dev`** when
  a second maintainer joins and transfer (GitHub redirects the old path).
- npm: unscoped **`credless`** (CLI) and the scope **`@credless`** (`playwright`, `mcp`, `adapter-*`, `demo`);
  confirm the scope with a logged-in `npm org create credless`.
- Domain to check: **credless.dev** (none of `.dev`, `.com`, `.io` resolved today; suggestive, not proof).

---

## 2. Positioning

**Tagline (11 words):** *Signed-in, multi-user Playwright E2E your coding agent runs without the key.*

**Description:** credless lets AI coding agents (Claude Code, Codex, Cursor) and humans write and run Playwright
end-to-end tests for signed-in, multi-user flows against dev or staging without the long-lived credential ever
reaching the agent, the test code or the evidence. Synthetic personas get one server-minted account per parallel
worker; a locked, dev-only test API mints real sessions and sets up state in one call; a loopback broker holds the
only key; every browser runs behind its own egress proxy that refuses production and unknown hosts, redirects,
WebSockets and WebRTC included; evidence is scrubbed and scanned, and a run fails if a secret value is found in it.
A contact sheet and a one-minute SUMMARY let a human judge the result, and a skill teaches the agent the method:
expected behaviour first, case list, cheapest layer, triage.

**Category we claim:** *test infrastructure a coding agent uses.* Identities, sessions, network policy and evidence
under Playwright, for tests an agent or a person writes. Not "AI writes your tests", not a browser agent, not a test
cloud. The durable open source here is infrastructure (Mailpit, Testcontainers, Playwright MCP/CLI); the "AI QA
engineer" products faded (01 §5).

**Why now:**

1. **Playwright said "build it outside".** Maintainers declined a first-party persona layer (#36540) and asked for
   it as a package; they declined native secret masking twice (#19992, open since 2023 with ~165 thumbs-up; #31728,
   closed same day) and suggested "a standalone package that post-processes Playwright's output"; when origin lists
   returned to Playwright MCP they were documented as "not a security boundary". The 1.65 `secrets` option (closed
   16 Oct 2026) covers redaction in reporters and traces, not minting, brokering, egress or fail-closed evidence.
   credless is the package they pointed at.
2. **Agents hit production and read `.env`.** Replit (Jul 2025), PocketOS (Apr 2026, a production database
   deleted "while working on a staging task"), a Supabase migration pointed at prod; Claude Code #401 (".env loaded
   at startup", open 13 months); Knostic's "Cursor swept up an API key". Teams now ask "what can it reach and read"
   before "what can it write". The market already buys "credentials never reach the model" (Stagehand, Browser Use,
   1Password); nobody extends it to test code, artifacts and network reach.
3. **"AI writes your tests" is fading; the plumbing is not.** Octomind shut down (mid-2026, "lack of market
   validation"), Magnitude pivoted to inference, Shortest is dormant; HN's root-cause thread (Oct 2026) reported "AI generated tests asserted that the defective behavior was correct" in
   every serious defect. The demand that survives is for evidence and isolation, which is what the kit is.

---

## 3. Target users, in priority order

| # | Who | Job they hire credless for | First thing they will try |
|---|---|---|---|
| 1 | **Teams adopting Claude Code or Cursor who got burned** (an agent read `.env`, touched prod, or a token turned up in a trace) | "Let the agent run our signed-in E2E suite on staging, provably without our credentials, with evidence I can skim in a minute." | `npx credless init`, `credless demo up`, then `--target staging` with the Supabase/Rails/Clerk adapter and one two-persona test. Their acceptance test: plant a fake secret, watch the run fail. |
| 2 | **QA/SDET leads with multi-user apps** (marketplaces, teams, workspaces, tenants) | "One account per worker without a spreadsheet of test users; owner/member/outsider in one test; a flake report instead of retries." | The persona catalog and `control.scenario()`; `--twice` on their flakiest spec; the contact sheet in a PR. |
| 3 | **Security teams setting agent policy** | "A written answer to 'what can the agent reach' that maps to our controls, with a boundary enforced server-side." | `SECURITY.md`, the threat model, `credless doctor --security`, the self-tests; they will try to break the proxy and the scrub. |
| 4 | **Auth providers and framework authors** (Clerk, Supabase, WorkOS, Auth0, Rails, Django, Laravel, Spring) | "A standard shape for 'mint a test session' we implement once and point our Playwright docs at." | The OpenAPI contract, the adapter interface, the `good first adapter` issues, a 150-line reference adapter to copy. |

Segment 1 is the Show HN reader. Segment 4 is the multiplier: one adapter in a vendor's docs beats any newsletter.

---

## 4. Messaging

**Safe claims** (04 §6, in our voice; each true today and tested):

- The agent and the test code never hold the test-API key. Only a loopback broker in the runner does, and a
  self-test (B01) proves the workers do not.
- The key is never in an environment variable, on a command line or in a container's configuration during a run;
  it moves as a 0600 file that global setup reads and deletes.
- Every persona browser runs behind its own egress proxy that refuses production and unlisted hosts before any
  connection or DNS lookup, including redirect hops and WebSockets; Chromium sends no WebRTC UDP.
- Evidence is scrubbed by value in four encodings, then scanned; anything still secret-shaped is deleted and
  listed; a leaked secret value fails the run; evidence that was not fully processed is deleted, never kept.
- Sessions are minted only for flagged synthetic test accounts, only on dev or staging, expire in one hour, and
  every call is audited with the key id. Nobody signs in as a real person; no shared human credentials exist.
- Production is refused by four client-side locks and is a 404 at the backend's five locks (say "once the ingress
  rule lands" until it exists in the reference backends).
- We publish our threat model and the gaps we have not closed.

**Forbidden claims** (never in a README, post, talk or reply):

- "The agent cannot exfiltrate anything", "sandboxed end to end": the Node worker is unrestricted until F1 ships,
  and the kit is not an OS sandbox.
- "Secrets never touch the agent" as an absolute: the broker token, minted cookies and the sign-in password are in
  the worker. Say "the long-lived credential".
- "Prevents prompt injection" (we bound the blast radius); "impossible to run against prod" (refused by code the
  agent could edit; the boundary is the backend).
- "SOC 2 compliant", "ISO 27001 certified"; "screenshots contain no secrets or PII" (regexes cannot read images);
  "no secrets in CI" until OIDC lands.
- Anything that reads as 1Password, Anthropic, Microsoft, GitHub or OWASP endorsing the kit; "safe" without its
  limits beside it; "zero trust"; "military-grade".

**The "not a security boundary" sentence** (verbatim in README, SECURITY.md and the skill):

> credless is not a security boundary. The boundaries are the broker process that holds the key and the test API's
> locks on your server; everything else in the kit (the guard, the egress proxy, the scrub, the deny rules, the
> lint gate) is defence in depth that an agent with shell access could in principle edit, which is why the
> self-tests check each layer and `credless doctor --security` tells you which ones are active on this machine.

**Compliance paragraph** (the only form in which SOC 2 and ISO appear):

> credless supports controls your auditors ask about; it does not make anything compliant. It supports SOC 2
> CC6.1 (least privilege: one scoped key, test accounts only, no shared human logins), CC6.2 (credential issuance
> tied to an identity), CC6.3 (role and namespace scoping), CC6.6 (boundary protection: egress allowlist, prod
> refusal), CC6.7 (restricted transmission: the key never leaves the broker, evidence is scrubbed), CC7.2 (an
> audit line per call; the leak check fails the run) and CC8.1 (locks tested in the build). Against ISO/IEC
> 27001:2022 Annex A it supports 5.15–5.18 (access control and identity), 8.2, 8.3, 8.5, 8.11 (data masking), 8.12
> (data leakage prevention), 8.15, 8.16, 8.28, 8.29, 8.31
> (separation of development, test and production) and 8.33 (test information: synthetic personas, no real PII).
> The evidence for each is the self-test that exercises it; the gaps are in the threat model.

Phrases security teams respond to: "no standing credential inside the agent's trust boundary"; "scoped,
short-lived, audited, revocable"; "blast radius: one test account for one hour"; "fail closed".

---

## 5. README outline

Order matters: the property, the code, the quickstart, then everything else. One screen before the first scroll.

1. **Title, tagline, one sentence, badges:** npm version · Apache-2.0 · "works with Claude Code, Codex, Cursor"
   (skills.sh badge once listed) · `selftest` CI · **"leak-vector suite: passing"** (the one badge no competitor
   can show). No star-history chart at launch.
2. **First-screen code sample** (a real test, generic app, two personas, evidence inline):

   ```ts
   import { expect, test } from '@credless/playwright';

   test('an outsider never sees the team document', async ({ personas, control }) => {
     const team = await control.scenario('team', { owner: 'owner', members: ['member'], documents: { member: 1 } }); // one call
     const [owner, outsider] = await personas.open('owner', 'guest');     // two browsers, already signed in
     await outsider.goto(team.document(0).url);
     await expect(outsider.getByText(team.document(0).title)).toHaveCount(0);
     await outsider.shot('outsider-document');                      // masked, scrubbed, scanned before it is kept
   });
   ```

   Under it, one contact-sheet PNG from the demo run (three browsers, three sizes).
3. **30-second quickstart against the bundled demo app** (a three-role notes app with its test API and Mailpit,
   in Docker):

   ```sh
   npx credless init          # config, persona catalog, the skill for your agent (Claude Code, Codex, Cursor)
   npx credless demo up       # demo app + its test API + Mailpit; nothing else on your machine
   npx credless run --target demo
   open reports/latest/SUMMARY.md
   ```

   Then the acceptance test: `npx credless demo plant-secret && npx credless run --target demo` fails with
   "secret value found in evidence". That is the sentence people will quote.
4. **What credless means, and what it does not:** the definition from section 1, the "not a security boundary"
   sentence, the three known limits (scan cannot read images; Node worker not network-isolated in native mode;
   evidence retention is yours). Humility here wins trust (02 §3).
5. **How it works:** one diagram (agent · test code · broker · test API · egress proxy · evidence), seven bullets,
   each linking to its doc and self-test.
6. **Comparison table** (cells yes / partial / no, a footnote per partial):

   | | Session minted server-side, no credential in test env | One synthetic account per worker | Two roles in one test | Prod/unknown hosts refused at network layer (redirects, WS) | Evidence scrubbed + scanned, run fails on leak | Teaches the agent a method |
   |---|---|---|---|---|---|---|
   | Playwright `storageState` + setup projects | no (`.auth` file "could be used to impersonate you") | partial (`parallelIndex` recipe) | partial | no | no | no |
   | Clerk Testing Tokens | partial (`CLERK_SECRET_KEY` in the test env) | no | no | no | no | no |
   | Playwright MCP `--secrets` / origin lists | no | no | no (two servers for two roles, #1530) | no ("not a security boundary", blind to redirects) | partial ("a convenience") | no |
   | agent-browser | partial (local vault; a browser, not a runner) | no | no | partial (allowlist, WebRTC off; opt-in) | no | no |
   | Browser Use `sensitive_data` | partial (placeholders; secret in process env) | no | no | partial (`allowed_domains`; default open) | no | no |
   | QA Wolf / Momentic | humans or env vars hold the credentials | service | service | no (half the field runs against prod) | storage, not enforcement | no |
   | **credless** | yes (broker + locked test API) | yes | yes | yes (per-browser egress proxy) | yes (fail-closed) | yes (skill) |

7. **Adapters:** the contract, the adapter interface, the list (shipped, community, wanted), the 150-line reference.
8. **For agents:** one install line per idiom (`npx skills add Prathyush-KKK/credless/skills`,
   `/plugin install credless@credless`, `.cursor/rules/credless.mdc`, `AGENTS.md` snippet, `llms.txt`).
9. **Running against your staging:** targets, slots, `doctor`, `health`, `--twice`, evidence layout, the GitHub
   Action (OIDC, contact sheet as a PR comment).
10. **Security** (link to `SECURITY.md`, threat model, self-test list, how to report), **status and roadmap**,
    **contributing**, **license**, one footer line for the company.

**The demo GIF (10 seconds, under 4 MB):** 0–2 s `credless run --target demo` starts, three browser tiles labelled
owner / member / outsider; 2–5 s the contact sheet fills in, codes visibly masked; 5–7 s `SUMMARY.md`: "12 passed ·
0 flaky · leak scan clean"; 7–10 s `demo plant-secret`, rerun, red: "secret value found in evidence, run failed,
staging deleted". End on the red line.

---

## 6. Launch plan

### Pre-launch checklist (all true before Show HN)

- [ ] Generic kit extracted from the private predecessor: `control.scenario()` replaces the private app's scenario call; public persona
      schema; no private product string in the package.
- [ ] Bundled demo app with the test API, Mailpit, `credless demo up|plant-secret|down`.
- [ ] Two reference adapters teams can copy on day one: **Supabase** (Next.js) and **Rails**; Clerk if
      `@clerk/testing` cooperates. The contract alone converts nobody (01 §4).
- [ ] Playwright 1.64+; the 1.65 `secrets` option as layer one, our scrub as layer two.
- [ ] The H-priority threat-model fixes shipped or honestly labelled: F2 canary, F3 lint gate, F8 supply-chain pins,
      F1 network namespace in docker mode (`doctor` says "isolated / not isolated"), F7 OIDC in the GitHub Action.
- [ ] **Leak-vector conformance suite** published and green: traces, HAR, HTML-report base64 zips, aria snapshots,
      console, step titles, CTRF, JUnit. This is the badge and the answer to every "but what about".
- [ ] `credless doctor --security`; `SECURITY.md` (threat model, data classes, the "cannot" list, disclosure policy).
- [ ] Agent surfaces: `skills/credless/SKILL.md` (`skills-ref validate` in CI), Claude plugin marketplace, Cursor
      rules, AGENTS.md snippet, `llms.txt`. MCP server is post-launch.
- [ ] npm trusted publishing with provenance; `publint` and `attw` clean; Node `>=24.12`.
- [ ] Names reserved; README, GIF, contact sheet and diagram per section 5; blog post and Show HN comment read by
      someone outside the company; three outsiders have run the quickstart cold (macOS, Linux, Windows via Docker)
      in under five minutes.
- [ ] Issue templates, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, ten "good first adapter" issues; founder's calendar
      clear for six hours after the HN post; two teammates on triage for the week.

### Sequence

1. **Soft launch (week 0, Mon–Wed).** Repo public. Playwright Discord `#show-and-tell`; the awesome-playwright PR;
   DMs to the ten people the research found scrubbing traces by hand or asking for origin lists (#19992
   commenters, the `myk9-platform` and `bis-platform` authors, the #1210 reporter, kettanaito). Fix what they hit.
2. **Blog post (week 0, Thursday)**, cross-posted to dev.to: the link behind every later post.
3. **Show HN (week 1, Tue–Thu, 8–10 am US Eastern).** Title and comment below. Same hour: Playwright Discord and the
   company's channels. No upvote asks.
4. **X/LinkedIn (same day and the next three).** One thread: the GIF, the red "run failed" frame, the comparison
   table, the "not a security boundary" sentence.
5. **Newsletters (weeks 1–3, one personal email each):** TestGuild, Ministry of Testing (newsletter and Tools
   Directory), Software Testing Weekly, Playwright Weekly, Software Testing Notes, Bytes, Node Weekly, TLDR (Web Dev
   and Infosec). Two sentences, the GIF, the post, one angle per audience (QA: personas and flakes; Node: broker and
   proxy; infosec: threat model).
6. **Talk proposals (weeks 2–6):** Playwright community events, TestGuild Automation Guild, TestBash, AI Engineer, a
   local OWASP chapter, NodeConf EU. Title: "Let the agent test it. Don't give it the password."
7. **Awesome-list PRs (one at a time):** `mxschmitt/awesome-playwright` "AI & Agents"
   (no auth, test-data or secrets entry exists; propose an "Auth & test data" subsection);
   `ai-boost/awesome-harness-engineering` ("Security, Sandbox & Permissions", "Evals & Verification");
   `hesreallyhim/awesome-claude-code`; `punkpeye/awesome-mcp-servers` once `@credless/mcp` exists; skills.sh.

### Show HN title and first comment

**Title (76 chars):** `Show HN: Credless – Let Claude Code run signed-in E2E tests without the password`

**First comment (founder, posted with the submission):**

> Hi HN. I built this for our own product, a multi-user app where the tests that matter are "the removed member
> sees nothing" and "the outsider gets a 404". That needs three or four signed-in browsers per test, and we wanted
> Claude Code to write and run those tests without being given a password, a service key or production.
>
> credless is the result, extracted into a kit. Personas are synthetic accounts, one per parallel worker, created
> by a dev-only test API behind five server-side locks. The runner reads the key once and hands it to a loopback
> broker; test code and the agent talk to the broker, never to the key (a self-test proves it). Each browser runs
> behind its own egress proxy that refuses production and unlisted hosts before DNS, redirects and WebSockets
> included. Evidence is scrubbed, scanned, and the run fails if a secret value is still in
> it. A skill teaches the agent the method: expected behaviour first, a case list, the cheapest layer that proves
> each case, no retrying a flaky test into green.
>
> What it is not: a security boundary. The boundary is the broker and your server's locks; the proxy, scrub and
> deny rules are defence in depth, and SECURITY.md lists what we have not closed (the Node worker is not
> network-isolated outside docker mode; the scan cannot read images). If you can get a secret past the published
> leak-vector suite, I want the issue.
>
> Try it: `npx credless init && npx credless demo up && npx credless run --target demo`, then
> `credless demo plant-secret` and watch the run fail. Adapters: Supabase, Rails, Clerk; an adapter is ~150 lines
> against an OpenAPI contract. Apache-2.0. I'll be here all day.

### Blog post

**Title:** "How we let Claude Code run signed-in E2E tests without giving it a password"

Outline (about 2,000 words, one diagram, the red-run screenshot):

1. The test we needed: four browsers, four roles, one assertion about what the outsider must not see.
2. The three refusals: a password in a prompt, a service key in `.env`, anything the agent runs reaching production.
3. What the field offers and where each stops (storageState, Clerk tokens, MCP `--secrets`, agent-browser's vault;
   "not a security boundary"; #36540 and #19992).
4. The design, piece by piece, each with the attack it answers: personas as accounts; the test API's five locks
   (Dusk CVE-2024-32003 as the cautionary tale); the broker and why the key moves as a file; the per-browser proxy
   and why Playwright routing cannot do it; evidence staged, scrubbed, scanned, fail closed.
5. What the agent does differently with the skill: a Claude session with and without it.
6. The threat model: which rows are closed, which are documented.
7. Adopting it: the contract, the adapter interface, the demo app.
8. Why we open-sourced it; the ask (adapters, break-it reports).

### Six-week content calendar

| Week | Piece | Channel |
|---|---|---|
| 0 | Repo public; blog post 1; awesome-playwright PR; Discord show-and-tell | Blog, Discord, GitHub |
| 1 | Show HN; X/LinkedIn thread; newsletter batch 1 (TestGuild, MoT, Software Testing Weekly) | HN, X, LinkedIn, email |
| 2 | Post 2: "Seven places a Playwright run leaks a secret, and a suite that checks all of them" | Blog, dev.to, X; newsletter batch 2 (Bytes, Node Weekly, TLDR) |
| 3 | Post 3: "A test-login endpoint that cannot exist in production: five locks and the CVE that shows why" | Blog; OWASP chapter proposal |
| 4 | Post 4: "One account per worker: synthetic personas for multi-user Playwright tests" + a 5-minute Supabase adapter video | Blog, YouTube, Playwright Discord |
| 5 | Post 5: "Teaching a coding agent to test: expected behaviour first, case list, cheapest layer" (with transcripts) | Blog; awesome-claude-code PR; skills.sh |
| 6 | Release 0.2: `@credless/mcp`, two community adapters merged; post 6: "What 30 days of issues taught us" | Blog, GitHub release, awesome-mcp-servers PR, CFPs submitted |

---

## 7. Community and contribution model

**License: Apache-2.0.** Every company-backed repo in the comparison set uses it (Microsoft, Google, Vercel,
TesterArmy); it matches Playwright; its patent grant is what security-minded adopters check; its trademark clause
keeps the name while the code is free; none of the breakout repos used BSL or FSL. A testing kit lives on the QA
consultancies and auth vendors who carry it into clients and docs; a source-available license keeps them out. Pair
it with a DCO sign-off (no CLA) and a short `TRADEMARK.md` ("credless" names this project; forks rename).

**CONTRIBUTING.md:** self-tests run in Docker (nothing on the host); contract, client and mock change together
(`contract:check` fails otherwise); edit the skill under `skills/` then `skill:sync`; `DECISIONS.md` and
`CHANGELOG.md` change in the same PR; never a secret in a test, fixture, issue or screenshot; what a good adapter PR
contains (adapter, mock, docs page, table row).

**SECURITY.md:** the threat model kept current; data classes and the "cannot" list; private disclosure via GitHub
Security Advisories or `security@` at the company domain; acknowledgement in 3 business days, triage in 7, 90-day
coordinated disclosure, credit by default; in scope: broker, proxy, scrub, locks, adapters; out of scope: Playwright
itself and "the agent can edit the kit", which is by design. No bounty at launch; say so.

**Code of conduct:** Contributor Covenant 2.1, verbatim, two named contacts (one not the founder).

**Issue templates:** Bug (requires `credless doctor --security` output; evidence folders are not attached whole);
Leak report (routes to SECURITY.md; asks for the shape and artefact type, never the value); Adapter proposal (auth
model, how a session is minted, which locks the backend can implement, mail/OTP story); Skill feedback; Docs.

**"Good first adapter" list** (each an issue with the interface, a mock to pass, and the reference to copy): Clerk
(testing tokens), Supabase (admin client, Mailpit on 54324), Auth0 (ROPG on a test connection), WorkOS Emulate,
Rails (Devise), Django, Laravel (Dusk `loginAs`, with the Winter CMS lesson applied), Spring
(`@ConditionalOnProperty`), Mailpit, 1Password (`op read`), Infisical (OIDC), Vault, Doppler (`--mount`). Two tiers:
*core* (we maintain: Supabase, Rails, Mailpit, the env/file/exec key sources) and *community* (named maintainer in
`ADAPTERS.md`, CI against their mock, release-notes credit).

**Governance for a company-backed repo:** `MAINTAINERS.md` with names and employers; decisions in `DECISIONS.md`,
with a lightweight RFC (issue labelled `rfc`, one week open) for contract changes and
anything touching the security model; CODEOWNERS with two reviews for `skills/`, `plugin/`, `bin/`, `scripts/` and
the proxy (an auto-updating skill is a one-PR path into every agent that installed it); signed release tags; a
public roadmap; the stated intent to move to the `credless-dev` org and add an outside maintainer within six months.

**Showing the company without putting people off:** one footer line ("Built by the maintainers for their own product's QA; it runs
our suite every day") and one badge; no pricing, no hosted upsell, no UTM links; employees say so in issues; a
plain "why we open-sourced it" paragraph in the blog post. A hosted offering, if ever, gets its own repo and site.

---

## 8. Metrics, goals and risks

Stars are vanity; track them, report on these.

| Metric | 30 days | 90 days | 180 days |
|---|---|---|---|
| `npx credless init` completions (proxied by npm installs of the CLI and quickstart click-through: **no telemetry in a kit whose pitch is "nothing leaves"**; an opt-in visible counter is an RFC at 90 days) | 300 | 1,500 | 5,000 |
| Demo runs (proxy: demo image pulls from GHCR) | 150 | 800 | 2,500 |
| Adapters contributed by non-employees, merged | 1 | 3 | 6 |
| Issues and discussions opened by non-employees | 20 | 75 | 200 |
| Teams running it against their own staging (self-reported) | 3 | 10 | 30 |
| Leak-vector suite: outside break-it reports received / closed | 2 / 2 | 5 / 5 | 10 / 10 |
| Auth vendor or framework linking the contract from its docs | 0 | 1 | 2 |
| Skill installs (`npx skills add`, plugin marketplace) | 100 | 500 | 2,000 |
| npm downloads per month (CLI + `@credless/playwright`) | 2,000 | 8,000 | 20,000 |

**Risks and responses:**

1. **Playwright ships native personas or secrets.** Partly true already: 1.65 has a `secrets` option. Response:
   integrate, do not compete. 1.65's redaction is layer one, our scrub, scan and fail-closed are layer two; the
   broker, the contract, the per-browser proxy and the evidence verdict are outside Playwright's stated scope
   (#36540, #31728, #1210). The kit shrinking because Playwright absorbed a piece is a win to announce.
2. **A bigger vendor copies it** (Microsoft, 1Password's Agentic Autofill in headless CI, Clerk, Vercel). Response:
   be the contract and the suite, not the feature. Adapters in vendors' own docs and a conformance suite others run
   against their tools is a position a copy cannot take. Offer each vendor the adapter PR before they write their own.
3. **Security-claim backlash** (a bypass posted on HN). Response: we said "not a boundary" first; the threat model
   is public; a bypass gets a thank-you, a self-test and a changelog line within days. A bypass of a documented gap
   is a documentation success; a bypass of a claimed property is a release the same week. Never argue; post the fix.
4. **"Another AI testing tool" fatigue** after Octomind, Magnitude, Shortest. Response: never say "AI writes your
   tests" or "self-healing"; lead with broker, proxy, personas, evidence, the red run.
5. **Nobody can adopt the test API without backend work.** Response: demo app plus two reference adapters at launch,
   the 150-line adapter, the good-first-adapter issues; measure "teams on their own staging", not stars.
6. **A supply-chain incident in a tool that preaches hygiene.** Response: F8 before launch, Renovate with a
   cooldown, an SBOM per release.
7. **The name misreads** ("no credibility"). Response: an FAQ entry; rename only if it measurably hurts.

---

## 9. One-page pitch (paste into a message to a friend)

Hey, quick one. Can I test an idea on you?

We built something for our own product and I think it should be open source. We want Claude Code (or Cursor, or
Codex) to write and run our end-to-end tests, including the ones that need several signed-in users at once, like
"the removed member sees nothing". But I will not paste a password into a prompt, put a service key in `.env` where
the agent reads it at startup (it does), or let anything the agent runs get near production. Every agent incident
this year (Replit, PocketOS, Cursor deleting prod) is one of those three.

So we built the plumbing and called it **credless**:

- **Personas**: synthetic users, one real account per parallel worker, created by a dev-only test API that sits
  behind five locks and does not exist in production.
- **A broker**: the runner reads the one key and hands it to a tiny loopback process; the agent and the test code
  talk to the broker, never to the key. A self-test proves the workers do not have it.
- **A proxy per browser**: each persona's browser can reach dev or staging and a short list of hosts; production
  and unknown hosts are refused before DNS, redirects and WebSockets included.
- **Evidence that fails closed**: screenshots, traces and logs are scrubbed and scanned, and if a secret value is
  still there the run fails and the evidence is deleted. You get a contact sheet and a one-minute summary.
- **A skill** that teaches the agent how to test: expected behaviour first, a case list, the cheapest layer that
  proves each case, never retry a flaky test until it passes.

Playwright's maintainers were asked for most of this and said "build it outside" (they declined persona APIs and
secret masking in writing). The AI-writes-your-tests companies are fading (Octomind shut down this summer). What
survives is infrastructure, and nobody has shipped this combination.

Honest limits: it is not a sandbox, and we say so. The boundary is the broker and the server; the rest is defence
in depth, and the threat model with its gaps is public.

The ask: `npx credless init && npx credless demo up && npx credless run --target demo` takes a minute. Then
`credless demo plant-secret` and watch it go red. Tell me (a) whether you would put it in front of your team,
(b) which auth stack you would need an adapter for, and (c) what would make you distrust it.

Apache-2.0, small company behind it, my name on the repo. "Bad idea" is a useful answer too.
