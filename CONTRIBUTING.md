# Contributing

Thank you for looking. The contributions that help most, in order: an adapter for an auth stack or a backend
framework, a break-it report against the leak-vector suite (through
[Security Advisories](https://github.com/Prathyush-KKK/credless/security/advisories/new) if it leaks a value, a
public issue if it bypasses a documented gap), a backend implementation of the contract you can point others at, and
docs fixes.

## Setup

```sh
git clone https://github.com/Prathyush-KKK/credless && cd credless
npm i -g corepack@latest            # Node 22 bundles corepack 0.34, which cannot start pnpm 11 or later
corepack enable                      # pnpm, the version package.json pins (or: npm i -g pnpm@12.14.0)
pnpm install --frozen-lockfile       # install scripts are off for every dependency (.npmrc); keep it that way
pnpm check                           # biome, typecheck, unit tests, contract, catalog, skill copy and shape, test-code gate, org gate, action tests
pnpm test                            # check plus the self-tests through the runner (scrub, scan and leak check run too)
pnpm verify                          # the release gate: test, the demo, the build, and the packed tarball installed into a blank project
pnpm smoke:registry                  # before a release: publish to a throwaway local registry, install with npm, pnpm, yarn, bun, -g, npx, dlx
```

Node 22.18 or later (every `.ts` is erasable, so Node runs the sources directly). The self-tests need Playwright's
browsers: `pnpm --filter ./packages/kit exec playwright install chromium`, or work inside the Playwright image
(`mcr.microsoft.com/playwright:v1.64.1-noble`). Nothing is installed on the host by the kit itself.

There is no hosted CI. `pnpm verify` is the gate: the maintainer runs it before merging a pull request and before
every release, and `pnpm release` refuses to publish unless it passes. Run it yourself before you open a pull
request and paste the last lines (the `PASS` lines and the smoke-test summary) into the description. If you run
GitHub Actions in your fork, [`docs/ci/checks.yml`](docs/ci/checks.yml) is the same gate as a workflow.

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
3. For anything a user sees, write the line a user would read in the changelog in the pull-request description;
   it goes into [CHANGELOG.md](CHANGELOG.md) at release. Internal refactors need none.
4. **Contract, client, broker allowlist and reference server move together.** A change to
   `contract/core.openapi.yaml` lands in the same pull request as `CORE_ROUTES`, the client, the demo's handler and
   the docs; `pnpm contract:check` fails otherwise.
5. **The skill is edited in one place.** Change `packages/kit/skills/e2e-testing/`, then `pnpm skill:sync`; the
   copy under `plugins/credless/skills/` must match (`pnpm skill:check`).
6. Words the tests look for are config, not literals in tests. Test code uses the kit's fixtures only: no
   `chromium.launch`, `newContext`, `proxy`, `launchOptions`, network or process modules, `process.env` or bare
   `fetch` (the lint gate and `check-tests` refuse them).
7. `pnpm verify` green locally, with its last lines in the pull-request description. Say if you could also run it
   on Windows or macOS; the maintainer runs it on Linux before merging.
8. Changes to `plugins/`, `action/`, `packages/kit/skills/` and `packages/kit/src/runner/` get the slowest review:
   an auto-updating skill, a CI action or the runner's key handling is a one-change path into every machine that
   installed it. Expect questions there, and expect small, single-purpose pull requests to land fastest.

## What a good adapter pull request contains

- The adapter under `packages/kit/src/adapters/<kind>/<name>.ts`, implementing one of the five interfaces
  (`SessionProvider`, `StateControl` extension, `KeySource`, `MailSink`, `AppSignals`) from `types.ts`, returning
  `Secret` for every sensitive value and never printing one.
- A unit test with a mock of the vendor's surface (no network in unit tests), and a self-test when the adapter
  touches the browser.
- A docs page under `docs/site/adapters/` with the auth model, how a session is minted, which of the five locks the
  backend side can implement, the mail or OTP story, and the known limits.
- A row in the adapters table in `docs/site/adapters.md` with its tier (`core`: maintained in this repository; `community`: a
  named maintainer, tests against the mock, release-notes credit).

## Reporting a bug

Use the bug template. It asks for `credless doctor --security` output (no secret in it) and the relevant lines of
`SUMMARY.md` or `scan.json`. Never attach an evidence folder whole: traces and reports are scrubbed, but they are
yours and they are large. A finding where a secret value survived the scrub is a security report, not a bug.

## Governance

credless is built and maintained by one independent developer, [@Prathyush-KKK](https://github.com/Prathyush-KKK).
There is no company behind it and no paid tier. Decisions that change the contract, the config schema or the
security model go through an `rfc` issue so they happen in public. A second maintainer is welcome once someone has
landed a few changes; they will be listed in `MAINTAINERS.md` and added to `.github/CODEOWNERS`. Releases are cut
locally with `pnpm release` (which runs `pnpm verify` first; `pnpm smoke:registry` beforehand, since it needs the
network) and tagged `v<version>`; the plugin marketplace points
at release tags, never at `main`.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies in every project space.
