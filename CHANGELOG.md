# Changelog

All notable changes to credless. The project follows [Semantic Versioning](https://semver.org); while it is 0.x, a
minor version may change the contract, the config schema or an adapter interface, and the entry says how to move.

## Unreleased

Fixes found by the predecessor's later runs, ported without its app-specific parts.

- `see()` looks at visible matches only: an app that keeps an earlier screen mounted and hidden no longer makes it
  wait on the hidden copy of the text.
- The project's theme is stored in the browser only while it holds none, so a theme the test switches to in the
  app survives the next page load.
- The guard on WebKit: its console and page-error copies of a fetch that a navigation cancelled are not counted as
  violations of their own (the request is still judged), a framed PDF blob WebKit cannot display is listed with the
  cancelled requests, and a blob URL is printed once (`blob:<url>`).
- A persona reset gets 120 s instead of the client's 30 s: parallel workers reset their personas at the same moment.
- The contract check requires the runner key on every route of the core and extension contracts; the backend brief
  says an extension contract declares it.

## 0.1.0

First public release.

- CLI: `init`, `doctor` (with `--security` and `--offline`), `slot`, `run` (slots, run locks, `--twice` flake
  report, Docker or native), `health`, `seed`, `report` (`list`, and the latest run by default), `evidence
  scrub|scan`, `check-tests` (the TypeScript AST when the project's `typescript` has a compiler API, else the same
  rules by tokenizer, TypeScript 7 included), `demo` and `demo --plant-secret`. `help <command>` and `<command> --help` print one
  command's options and examples; a usage error is one line and a pointer; a mistyped command gets a suggestion.
- Personas: a catalog of synthetic roles; one account per persona per parallel worker; several signed-in browsers in
  one test.
- Test API: a seven-route core contract (OpenAPI 3.1) with an extension pattern, a backend brief with five locks, and
  `credless/server`, the reference handler for Node backends.
- Key broker: the test-API key read once from env, file, OS keyring or a vendor CLI, handed over as a 0600 file and
  held only by a loopback broker; workers use a per-run token.
- Egress proxy per browser: production and unlisted hosts refused before any connection (redirects, WebSockets and
  WebRTC included), DNS pinned, private addresses refused, a canary per context, limits.
- Evidence: private staging, scrub in four encodings (zips inside the HTML report and traces included), scan,
  quarantine, fail-closed post-run, `SUMMARY.md`, coverage, contact sheets, CTRF/JUnit/blob coverage, Playwright 1.65
  `trace.secrets` when available.
- Agent surfaces: an Agent Skill, a Claude Code plugin and marketplace with a secret-blocking `PreToolUse` hook, a
  Cursor rule and an `AGENTS.md` snippet; a composite GitHub Action with a job summary and pull-request comment.
- A bundled demo app ("documents for teams") that runs from the npm package with `npx credless demo`.
- Installs: npm, pnpm, bun, Yarn classic and Yarn 4 with `nodeLinker: node-modules`, plus `npm i -g`, `npx`,
  `pnpm dlx` and `bunx`, each checked against a local registry before release. Yarn Plug'n'Play is refused with the
  fix rather than failing halfway.
