# Decisions

One line per proposal the v0.1 tasks raised against the frozen interfaces (`docs/conventions.md`,
`packages/kit/src/types.ts`) and per choice the assembly made. Format: source: what was proposed, what was done.

## Interfaces

- Task 1: `ControlInternals` cannot be `implements`-checked. Its doc comment says so; `Control` mirrors it as
  protected members.
- Task 1: `defaultSignals(partial, { apiOrigin })` needs the api origin. Kept; the fixtures pass `endpoints.api`.
- Task 1: no "staging unless allowed" knob. Kept Task 1's rule: a production word in a target's name or hosts is
  refused always, any other declared target is allowed. A per-target `requireConfirmation` is v0.2 if wanted.
- Task 1: `loadRunConfig(env, kitConfig)` plus `importKitConfig(path)` replace the stub's one call. The runner
  composes them in `runner/deps.ts` (`loadProjectConfig`); `global-setup.ts` uses the same.
- Task 1: factory aliases (`createKeySource` and friends), `StartBrokerOptions`, `RouteTable` from the contract,
  resolver-taking sink and provider factories. Kept as shipped; the aliases go in v0.2.
- Task 2: `EgressProxyOptions.contextId` optional. Applied; the proxy generates `ctx-<random>` when absent.
- Task 2: the schema should default `hosts.analytics` to the kit's list. Not changed: the fixtures fall back to the
  kit list when the list is empty, so `[]` means "the defaults"; an explicit "none" is v0.2.
- Task 2: resolve `control.module`, `session.module` and `mail.module` against the config dir. Applied in
  `loadRunConfig`; the module loaders import an absolute path as a file URL (Windows included).
- Task 2 and Task 4: where workers find the config. Unchanged: `<kit>.config.*` in the directory the run starts in,
  which is the project root `run` uses; a `CREDLESS_CONFIG` row is v0.2 if a layout needs them apart.
- Task 2: the `egressLookup` self-test option and the wider `KitTest` type. Kept; `check-tests` forbids
  `egressLookup` with the other launch options.
- Task 2: the config file must be ESM. Documented (conventions §12); a `doctor` check is v0.2.
- Task 3: `ScrubResult` carries a non-enumerable `collected`. Said in the `ScrubResult` doc comment.
- Task 3: scan.json's three extra fields. Added to `ScanResult` as optional (`leftAfterRemoval`, `secretValues`,
  `secretValuesIn`); `ScanFile` is the required form post-run writes.
- Task 3: the evidence-key fallback to the run id, and the "unlisted host" phrase SUMMARY.md reads. Both in
  conventions (§7, §6).
- Task 3: `trace.secrets` only for values workers hold. Kept; the generated Playwright config passes the plain
  trace mode (no value is known at config time).
- Task 4: `ENV.WORKER_PROXY_URL`. Added; `WORKER_PROXY_ENV` is that constant.
- Task 4: the marker travels with the kept folder. Yes (conventions §3, §7).
- Task 4: docker mode bind-mounts the project with its node_modules. Kept for v0.1; `docker.ts` takes the mounts as
  data, the named volume is v0.2.
- Task 4: a local target's key comes from the config's own source. The demo writes a fresh stand-in key with
  `--write-key` and the configs read it through `CREDLESS_DEMO_KEY_FILE` (Task 5's proposal); the harness and
  `credless demo` both do this.
- Task 4: the image digest table is unpinned. Unchanged; `doctor` says "unpinned".
- Task 5: the `CREDLESS_DEMO_KEY_FILE` row. Added (`ENV.DEMO_KEY_FILE`). In `server.ts` the `--write-key` flag now
  wins over the variable, because the harness sets the variable for its own processes and the server inherits it.
- Task 5: exempt `**/e2e/*.config.ts` from the biome override and the AST gate. Applied: biome excludes it;
  `check-tests` skips `*.config.*` in a directory walk and still checks a file named on the command line.
- Task 5: `fixtures.ts` narrows `control` to `DemoControl`. Kept; a typed `defineTest<DemoControl>()` is v0.2.
- Task 5: a `shot.pixelAt` for pixel proofs in test code. Not added; the demo's F02/F03 assert what the fixtures
  expose, the kit's own E04/E05 use the `shotPixel` helper from `fixtures/evidence.ts`.
- Task 5: the demo imports the kit's source by path. Kept for `apps/demo/e2e/credless.config.ts` only (the CLI
  imports it with plain Node before any build); the specs and the control import `credless` and `credless/adapters`
  through tsconfig paths.
- Task 7: root `skill:sync`, `skill:check`, `skill:validate`. Added; `check` runs the validator (built-in checks
  always, skills-ref through npx when reachable).
- Task 7: `templates/` into the published package. Moved to `packages/kit/templates/` (`files` lists it;
  `templatesDir()` looks there first). An eighth template, `playwright.config.ts`, makes an `init` project runnable:
  it spreads `kitPlaywrightConfig()` from `credless/config` (reporters, global setup, no retries).
- Task 7: the `init` body. In `runner/cli.ts`: `--target`, `--web`, `--api`, prompts on a TTY, `--yes` for the
  defaults; prints written, appended and kept files and the two next steps.
- Task 7: the rename list. Conventions §1.
- Task 8: `.gitignore` gains `.org-gate.local` (and `.release/`). Done.
- Task 8: root `release`, `org-gate`, `test:action`. Added; `check` runs the gate non-strict and the action's tests.
- Task 8: Starlight. Not wired; `docs/site/` stays plain Markdown with relative links.
- Task 8: the example app-level error code in the skill. Replaced by a made-up one (4201); the plugin copy re-synced.
- Task 8: the action and the dogfood workflow. The action resolves the CLI with Node from its working directory
  (never npx's registry fallback) and the dogfood runs with `working-directory: apps/demo`.
- Task 8: `credless demo --plant-secret`. Still planned; the docs say so.
- Task 8: E09 landed, so the README and quickstart sentences about the planted secret stand.

## Dependencies

- `.needs-deps.md` (Task 5): `vitest@5.0.5` in `apps/demo` devDependencies. Added; the tsconfig path shim is gone,
  `apps/demo` has `unit: vitest run` and the root `unit` runs both packages. No new runtime dependency anywhere.

## Harness and CI (Task 6)

- Playwright 1.64's `webServer.wait: { stdout: /ready web=(?<DEMO_WEB>\S+) api=(?<DEMO_API>\S+)/ }` puts the named
  groups into `process.env` (uppercased) and the plugin runs before global setup, so the origins and the key file
  are in place when the kit config is read for the run.
- The demo starts as the webServer of the kit's config and of the demo's own config; under `credless demo` the CLI
  starts it and the demo's config leaves the webServer out (`DEMO_WEB` is set).
- `kitPlaywrightConfig()` (`runner/playwright-config.ts`, exported from `credless/config`) is the one place the
  reporters, the global-setup path, the trace and worker knobs and `retries: 0` are spelled; the kit's, the demo's
  and the template's Playwright configs spread it.
- The broker's allowlist is the core contract plus `testApi.contract` (global setup), the table the workers' client
  already used; the first run through the harness found it core-only (C01, C04 and C05 failed on it).
- `report summary` prints the kept SUMMARY.md instead of re-rendering a folder that is already evidence.
- `--twice` keeps Task 3's layout: post-run once, with the first folder, `compareWith` the second.
- The lockfile is written by pnpm 12 (`packageManager`); pnpm 10 reports it as broken and resolves from
  node_modules. CI and contributors use the pinned version (corepack or pnpm/action-setup).
- `checks.yml`: Linux and Windows, Node 24, `pnpm check` then the self-tests through the CLI, the evidence kept 14
  days, and a build job (tsdown, publint, attw, dry-run pack). The Windows job could not be run from the assembly
  machine; see the first CI run.
