# Changelog

All notable changes to credless. The project follows [Semantic Versioning](https://semver.org); while it is 0.x, a
minor version may change the contract, the config schema or an adapter interface, and the entry says how to move.

## 0.1.0 (unreleased)

First public release.

- CLI: `init`, `doctor` (with `--security` and `--offline`), `run` (slots, run locks, `--twice` flake report,
  Docker or native), `health`, `seed`, `report`, `evidence scrub|scan`, `check-tests`, `demo` and
  `demo --plant-secret`.
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
