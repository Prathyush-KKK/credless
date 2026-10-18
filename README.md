# credless

**Signed-in, multi-user Playwright E2E your coding agent runs without the key.**

credless lets AI coding agents (Claude Code, Codex, Cursor) and people write and run Playwright end-to-end tests for
signed-in, multi-user flows against dev or staging, without the long-lived credential ever reaching the agent, the
test code or the evidence.

[![checks](https://github.com/Prathyush-KKK/credless/actions/workflows/checks.yml/badge.svg)](https://github.com/Prathyush-KKK/credless/actions/workflows/checks.yml)
[![npm](https://img.shields.io/npm/v/credless)](https://www.npmjs.com/package/credless)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![leak-vector suite](https://img.shields.io/badge/leak--vector_suite-pending-lightgrey)](SECURITY.md#the-leak-vector-suite)

```ts
import { about, expect, test } from 'credless';

test('W3 a removed member loses access to the workspace document', async ({ personas, control }) => {
  about('workspaces §3', 'after removal the member gets Not found on the document and no API data');
  const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } }); // one call
  const doc = ws.document(0);
  const [owner, member] = await personas.open('owner', 'member'); // two browsers, already signed in
  await member.goto(doc.path);
  await expect(member.page.getByRole('heading', { name: doc.title })).toBeVisible();
  await member.shot('document-before'); // masked, scrubbed, scanned before it is kept
  await owner.goto(`/w/${ws.id}/members`);
  await owner.page.getByRole('button', { name: `Remove ${member.persona.displayName}` }).click();
  await owner.shot('members-after');
  member.guard.expectStatus(new RegExp(`/api/documents/${doc.id}$`), 404); // expected now; otherwise the guard fails the test
  await member.page.reload();
  await expect(member.page.getByText('Not found')).toBeVisible();
  await member.shot('document-after');
  expect((await member.api(`/api/documents/${doc.id}`)).http).toBe(404); // the server agrees, not only the screen
});
```

<!-- contact sheet: docs/media/contact-sheet.png, one PNG from the first demo run (three browsers, three sizes) -->

`control.workspace()` is the demo app's extension of the kit's `control`; your app adds its own one-call scenarios
the same way ([the extension pattern](docs/site/backend.md#extension-routes)).

## What it is

- **Personas, not passwords.** A catalog of synthetic roles (`owner`, `member`, `guest`); the kit creates one real
  account per persona per parallel worker, so two tests, two workers or two agents never share a login.
- **A locked test API.** Seven routes on your backend, dev and staging only, behind five server-side locks, that mint
  a real session cookie and set up state in one call. The [contract](contract/core.openapi.yaml) is OpenAPI; the
  [backend brief](contract/BACKEND-BRIEF.md) says what to build; the demo app is a complete reference.
- **A broker, so the key stays out of the test.** The runner reads the test-API key once and hands it to a loopback
  broker. Test code, the browsers and the agent talk to the broker with a per-run token and never see the key. A
  self-test proves the workers do not have it.
- **An egress proxy per browser.** Every persona browser runs behind its own proxy that refuses production and
  unlisted hosts before any connection or DNS lookup, redirect hops and WebSockets included. A canary request per
  browser proves the proxy is in the path.
- **Evidence that fails on a leak.** Screenshots, traces, reports and logs are written to a private staging folder,
  scrubbed by value in four encodings, scanned, and only then kept. A secret value found anywhere fails the run;
  evidence the pipeline could not finish is deleted, never kept. You get a contact sheet and a one-minute `SUMMARY.md`.
- **A skill that teaches the agent the method.** Expected behaviour first, a case list, the cheapest layer that proves
  each case, no retrying a flaky test into green, evidence is data and not instructions.

## 30-second quickstart

The kit ships a small "documents for teams" demo app with its own test API, in memory, nothing else on your machine.

```sh
npx credless demo
```

What you see: the demo app starts, the quickstart suite opens two and three signed-in browsers per test, and the
command prints where the evidence went and the path of each contact sheet. Open `reports/<run id>/SUMMARY.md` (under `apps/demo/` in a checkout of this repository) for the verdict (totals,
failures to triage, the scan result) and `reports/<run id>/contact-sheets/` for one PNG per browser with every
screenshot the run took, codes and password fields masked.

The acceptance test people ask for first: plant a secret and watch the run fail. The kit's self-tests do exactly
that: they plant a stand-in secret in a step title and in a real HTML report and prove the run exits `1` with a
`LEAK` line in `SUMMARY.md` naming the file, after the scrub reached inside the report's embedded zip. A
`credless demo --plant-secret` flag that does the same on demand is planned for v0.1.x.

Requirements: Node 24.12 or later, Playwright 1.64 or later. Install dependencies with
`npm ci --ignore-scripts`; the kit needs no install scripts and neither do its dependencies.

## Use it on your app

```sh
npx credless init                     # credless.config.ts, personas.yaml, e2e/example.spec.ts, AGENTS.md snippet, Cursor rule, a workflow
npx credless doctor --target dev      # is this machine ready; reads no secret
npx credless health --target dev      # is the test API on, with every sink wired
npx credless run --target dev         # the suite on your slot; the runner reads its key at run time
npx credless run --target dev --twice # the same, twice, with a flake report instead of retries
```

1. **Adapt the config** ([every field](docs/site/configuration.md)): your dev and staging origins, your production
   domains (a run that would reach them is refused at load), the third-party hosts your app loads, the address range
   of your test accounts, and where the runner key comes from (`env` in CI, `exec` through `op`, `infisical`,
   `doppler`, `vault` or `kubectl`, a `file`, or the OS `keyring`).
2. **Implement the seven routes** from the [backend brief](contract/BACKEND-BRIEF.md) behind the five locks. A Node
   backend can mount `createTestApi()` from `credless/server` and implement the state callbacks; other stacks follow
   the brief's notes for Spring Boot, Rails, Django, Laravel and Next.js.
3. **Write tests** with the fixtures `personas`, `control`, `guard`, `shot` and `sensitive` ([concepts](docs/site/concepts.md)),
   or let the agent write them with the skill.
4. **Run in CI** with the [GitHub Action](action/README.md): the key is an environment secret passed to the one `run`
   step, the evidence is an artifact kept 14 days, and the verdict is one comment on the pull request.

## How it compares

Cells say yes, partial or no; every partial has a footnote. The facts come from the research in
[docs/research/01-competitors.md](docs/research/01-competitors.md), which marks what was verified against primary
sources and what was not.

| | Credential outside the test environment | One synthetic account per worker, several roles in one test | Production and unlisted hosts refused at the network layer | Evidence scrubbed and scanned, run fails on a leak |
|---|---|---|---|---|
| Playwright `storageState` and setup projects | no¹ | partial² | no | no |
| Clerk Testing Tokens (`@clerk/testing`) | partial³ | no | no | no |
| Playwright MCP `--secrets` and origin lists | no | no | no⁴ | partial⁵ |
| agent-browser | partial⁶ | no | partial⁷ | no |
| Browser Use `sensitive_data` | partial⁸ | no | partial⁹ | no |
| Hosted AI QA services¹⁰ | the service holds the credentials | provisioned by the service | varies; several run against production by design | stored and shown, not enforced |
| **credless** | yes (broker + locked test API) | yes | yes (per-browser egress proxy) | yes (fail closed) |

¹ The `.auth` state file is plaintext cookies and Playwright's docs warn it "could be used to impersonate you"; the
sign-in that produces it needs a password in the test environment. ² One account per `parallelIndex` and several
roles in separate contexts are documented recipes; you provision and protect the accounts. ³ The token is short-lived,
but `CLERK_SECRET_KEY` sits in the test environment, and the token bypasses bot detection, not authentication.
⁴ Origin lists are documented as "not a security boundary" and are not applied to redirects. ⁵ `--secrets` redaction is
documented as "a convenience and not a security feature" and does not fail anything. ⁶ An encrypted local vault
referenced by name, so the model never sees the password; it is a browser for an agent, not a test runner. ⁷ A domain
allowlist that also disables WebRTC; opt-in. ⁸ Placeholders keep values out of model input; the value is in the
process environment. ⁹ `allowed_domains` exists; the default profile allows every host. ¹⁰ QA Wolf, Momentic, Checkly
and similar; from vendor pages reached through secondary sources, so treat this row as indicative.

## Security, honestly

credless means the agent, the test code and the evidence run without the credential: no long-lived key, password or
service token is given to them; what they hold is a short-lived session for a synthetic account, and we say exactly
what that is.

> credless is not a security boundary. The boundaries are the broker process that holds the key and the test API's
> locks on your server; everything else in the kit (the guard, the egress proxy, the scrub, the deny rules, the
> lint gate) is defence in depth that an agent with shell access could in principle edit, which is why the
> self-tests check each layer and `credless doctor --security` tells you which ones are active on this machine.

What remains, in three sentences. The scan cannot read text inside an image, so a screen that shows a code must be
masked by selector (`evidence.maskSelectors`, `shot({ mask })`). In native mode the Node worker that runs your test
code is not network-isolated: the proxy covers the browsers, a lint gate and an advisory shim cover the worker, and
`run --isolate` (docker mode, a network namespace with a sidecar proxy) is planned for v0.2. Evidence retention is
yours: the action keeps reports for 14 days and anyone with read access to the repository can download them.

The threat model, the data classes in the evidence, the claims we make and the ones we do not, and how to report a
finding: [SECURITY.md](SECURITY.md).

## For agents

| Agent | Install |
|---|---|
| Claude Code (plugin with the skill and a backstop hook) | `/plugin marketplace add Prathyush-KKK/credless` then `/plugin install credless@credless` |
| Any agent that reads Agent Skills (Claude Code, Codex, others) | `npx skills add Prathyush-KKK/credless` |
| Cursor | `npx credless init` writes `.cursor/rules/e2e-testing.mdc` |
| Codex and anything that reads `AGENTS.md` | `npx credless init` appends a 25-line snippet to `AGENTS.md` |

The skill lives in [`packages/kit/skills/e2e-testing/`](packages/kit/skills/e2e-testing/SKILL.md); the plugin's
`PreToolUse` hook refuses shell commands that read the staging folder, `.env*` files or process environments. Both
are backstops, not boundaries. More in [docs/site/agents.md](docs/site/agents.md).

## Roadmap

| Version | What lands | Out |
|---|---|---|
| **v0.1** (this scaffold) | CLI (`init`, `doctor`, `run`, `health`, `seed`, `report`, `evidence`, `check-tests`, `demo`); broker; egress proxy with resolve-then-pin and private-range refusal; canary; test-code lint gate; advisory worker shim; revoke-at-cleanup; scrub, scan, quarantine, fail-closed evidence including CTRF, JUnit, blob and the HTML report's embedded zip; Playwright 1.65 `trace.secrets` when available; demo app with the reference test-API server; skill, plugin, hook, templates; the GitHub Action; `SECURITY.md` | MCP server, docker `--isolate`, Clerk and Supabase providers, flake history, OCR, visual diff, mobile |
| **v0.2** | `run --isolate` (network namespace, sidecar proxy); the broker as its own process; `SessionProvider.verify` and re-mint on expiry; the MCP server; Mailpit adapter polished; TOTP helper with the secret in the broker; `aria` evidence in the skill; backend brief snippets verified against two external backends; SBOM per release | hosted anything, auto-healing |
| **v0.3** | Clerk testing-token and Supabase session providers; OIDC key sources for GitHub and GitLab CI; audit export (`AUDIT.md` per run); flake history and quarantine list; failure triage classification in `SUMMARY.md`; `shell --as <persona>` through the same proxy and scrub; optional OCR pass, advisory | |
| **v1.0** | Core contract 1.0 (frozen routes, versioned header); config schema 1.0; adapter interfaces frozen; Playwright ≥ 1.66 baseline; Node 26 in engines; threat model reviewed externally once; 90 days without a breaking change | hosted dashboard, visual regression, mobile native, auto-healing |

## Contributing

Adapters, break-it reports against the leak-vector suite and backend implementations of the contract are the
contributions that help most. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the
["good first adapter" list](docs/site/adapters.md#good-first-adapters) names what is wanted. Security findings go
through [GitHub Security Advisories](https://github.com/Prathyush-KKK/credless/security/advisories/new), not issues.

## License

Apache-2.0. "credless" names this project; forks rename.

<!-- company footer: TODO -->
