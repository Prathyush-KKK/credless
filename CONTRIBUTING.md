# Contributing

Thank you for looking. The contributions that help most, in order: an adapter for an auth stack or a backend
framework, a break-it report against the leak-vector suite (through
[Security Advisories](https://github.com/Prathyush-KKK/credless/security/advisories/new) if it leaks a value, a
public issue if it bypasses a documented gap), a backend implementation of the contract you can point others at, and
docs fixes.

## Setup

```sh
git clone https://github.com/Prathyush-KKK/credless && cd credless
corepack enable                      # pnpm, the version package.json pins
pnpm install --frozen-lockfile       # install scripts are off for every dependency (.npmrc); keep it that way
pnpm check                           # biome, typecheck, unit tests, contract, skill copy, catalog
pnpm test                            # check plus the self-tests through the runner (scrub, scan and leak check run too)
```

Node 22.18 or later runs the workspace (every `.ts` is erasable); the published package declares Node 24.12 or
later. The self-tests need Playwright's browsers: `pnpm --filter ./packages/kit exec playwright install chromium`,
or run inside the Playwright image (`mcr.microsoft.com/playwright:v1.64.1-noble`), which is what CI does. Nothing
is installed on the host by the kit itself.

## Rules that are not negotiable

- **Never a secret in a test, a fixture, an issue, a screenshot or a commit.** Not a real one and not a realistic
  fake that a scanner would flag. The demo's stand-in secrets live in `apps/demo/src/fake-secrets.json` and are
  scanned for like real ones. If you think a value slipped into history, say so in a private advisory and we rotate.
- **Never a real person.** Personas are synthetic; addresses live inside the configured test range; names are
  generated.
- **No organisation-specific strings.** Examples use `example.com`, `app.example`, `api.example`,
  `qa+<ns>-<persona>@example.com` and reserved TLDs. `node scripts/org-gate.mjs` runs a private pattern list
  (`.org-gate.local`, never committed; `.org-gate.example` shows the shape) over the tree and fails on a hit.
- **No hidden retries.** `retries` stays 0 in every config the kit ships; flakiness is reported by `run --twice`,
  never retried into green.
- **No install scripts.** A dependency that needs one is a decision with a reviewed reason, not a line in
  `pnpm-workspace.yaml`.

## How a change goes in

1. Open an issue first for anything that touches the contract, the config schema, an adapter interface or the
   security model; label it `rfc` and leave it open a week. Small fixes can go straight to a pull request.
2. One pull request, one change. Sign off your commits (`git commit -s`, the
   [Developer Certificate of Origin](https://developercertificate.org/)); there is no CLA.
3. Add a changeset for anything a user sees: `pnpm changeset`, pick the bump, write the line a user reads in the
   changelog. Internal refactors need none.
4. **Contract, client, broker allowlist and reference server move together.** A change to
   `contract/core.openapi.yaml` lands in the same pull request as `CORE_ROUTES`, the client, the demo's handler and
   the docs; `pnpm contract:check` fails otherwise.
5. **The skill is edited in one place.** Change `packages/kit/skills/e2e-testing/`, then `pnpm skill:sync`; the
   copy under `plugins/credless/skills/` must match (`pnpm skill:check`).
6. Words the tests look for are config, not literals in tests. Test code uses the kit's fixtures only: no
   `chromium.launch`, `newContext`, `proxy`, `launchOptions`, network or process modules, `process.env` or bare
   `fetch` (the lint gate and `check-tests` refuse them).
7. `pnpm test` green locally; CI runs the same on Linux and Windows.
8. Two approving reviews are required for `plugins/`, `action/` and `packages/kit/src/runner/` (an auto-updating
   skill or a CI action is a one-change path into every machine that installed it). One review elsewhere.

## What a good adapter pull request contains

- The adapter under `packages/kit/src/adapters/<kind>/<name>.ts`, implementing one of the five interfaces
  (`SessionProvider`, `StateControl` extension, `KeySource`, `MailSink`, `AppSignals`) from `types.ts`, returning
  `Secret` for every sensitive value and never printing one.
- A unit test with a mock of the vendor's surface (no network in unit tests), and a self-test when the adapter
  touches the browser.
- A docs page under `docs/site/adapters/` with the auth model, how a session is minted, which of the five locks the
  backend side can implement, the mail or OTP story, and the known limits.
- A row in the adapters table in `docs/site/adapters.md` with its tier (`core`: we maintain it; `community`: a
  named maintainer, CI against the mock, release-notes credit).

## Reporting a bug

Use the bug template. It asks for `credless doctor --security` output (no secret in it) and the relevant lines of
`SUMMARY.md` or `scan.json`. Never attach an evidence folder whole: traces and reports are scrubbed, but they are
yours and they are large. A finding where a secret value survived the scrub is a security report, not a bug.

## Governance

Decisions that change the contract, the config schema or the security model go through an `rfc` issue. Maintainers
are listed in `MAINTAINERS.md` once there is more than one; the stated intent is to move the repository to a
`credless-dev` organisation and add an outside maintainer within six months of the first release. Release tags are
signed; the plugin marketplace points at release tags, never at `main`.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies in every project space.
