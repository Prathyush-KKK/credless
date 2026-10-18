# CLI reference

`npx credless <command>`; `npx credless help <command>` (or `<command> --help`) prints one command's options and
examples. A usage error prints one line and that pointer; a mistyped command gets a suggestion. No shell is spawned anywhere (`execFile` with argv arrays); children get an environment
allowlist, never `process.env`; a child's stdio passes through a redacting stream.

| Command | What it does |
|---|---|
| `init [dir] [--yes]` | writes `credless.config.ts`, `personas.yaml`, `e2e/example.spec.ts`, an `AGENTS.md` snippet, a Cursor rule, `.github/workflows/e2e.yml` and a suggested `.claude/settings.json` deny block from the templates |
| `doctor [--target t] [--offline] [--security] [--slot x] [--docker\|--native]` | tools, Node, Docker, browsers, slot, staging permissions, key source by presence, target probe without a key; `--security` prints the active layers ([SECURITY.md](../../SECURITY.md#credless-doctor---security)). Reads no secret |
| `slot [letter]` | without a letter, prints this machine's slot and where it comes from (`--slot`, `CREDLESS_SLOT`, or the slot file); with one, writes it to the slot file (`$XDG_CONFIG_HOME/credless/slot`, else `~/.config/credless/slot`; `%APPDATA%\credless\slot` on Windows). A remote target needs one; every machine has its own |
| `run --target t [--slot x] [--workers n] [--twice] [--docker\|--native] [--project p] [--wait m] [-- <playwright args>]` | the suite; refuses production and unknown targets; takes the target+slot lock (waits `--wait` minutes); reads the key, starts the broker, runs Playwright, runs post-run; exit 0 pass, 1 fail or a leaked value, 2 usage, 4 evidence unsafe. `--twice` runs the suite twice and writes `FLAKES.md`. Without `--docker` or `--native` it uses docker when the daemon answers. `--isolate` is v0.2 |
| `health --target t` | the test API is on and its sinks are wired (`GET /health` through the key, prints no secret) |
| `seed --target t [--slot x] [--workers n]` | ensure the personas for every namespace of this slot ahead of a run |
| `report [list \| summary [runId] \| open [runId] \| compare <runId> <runId>]` | `list` prints the kept runs, newest first, with their verdicts; `summary` (the default) prints `SUMMARY.md` and `open` opens the HTML report, of the latest run when none is named; `compare` writes `FLAKES.md` for two runs. Outside a project it reads `./credless-demo/reports`, where `demo` keeps its runs |
| `evidence scrub\|scan <dir> [--values-file f]` | the pipeline by hand on a folder; `scan` exits 1 on a finding and prints file and kind, never a value |
| `check-tests [dir...] [--engine ts\|regex]` | the test-code lint gate: forbids browser launches, `newContext`, `proxy`, `launchOptions`, `ignoreDefaultArgs`, network and process modules, `process.env` and bare `fetch` in test dirs |
| `demo [--headed] [--plant-secret] [--demo-dir d] [--target t]` | starts the bundled demo app, runs the quickstart suite against it through `run` with the app's ephemeral origins as overrides, and prints where `SUMMARY.md` and the contact sheets are (`credless-demo/reports/` under the working directory when run from the npm package). `--plant-secret` adds one spec that leaks the demo's stand-in password into the output on purpose and exits 0 only if the run failed with a `LEAK` |
| `help [command]`, `version` | the command list, or one command's usage, what it does and examples |
| `mcp` | v0.2: a stdio MCP server over the same CLI |

Common option: `--config <file>` (default: the nearest `credless.config.ts` above the working directory).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every test passed and the evidence is clean |
| 1 | a test failed, or a secret value was found in the evidence (scrubbed, kept, and the run failed because a code path leaked) |
| 2 | usage: unknown or production target, bad flag, missing tool, lock held past `--wait`, no key source, Yarn Plug'n'Play, `doctor` refused |
| 4 | the evidence is not safe to keep: post-run failed or something secret-shaped survived the scrub; the staging folder was deleted |

The GitHub Action exits with the same code.

## Modes

`--native` runs Playwright on this machine. `--docker` runs it in the pinned Playwright image (digest checked by
`doctor`) with an environment allowlist and the staging dir mounted; the key is handed over as a file in staging,
never with `-e`, so `docker inspect` shows nothing. Windows: paths under `%LOCALAPPDATA%\credless\staging`; mode bits
are advisory there and `doctor` says so.

## Locks and slots

The slot comes from `--slot`, then `CREDLESS_SLOT`, then the slot file `credless slot <letter>` writes. A local
target (the demo, the self-tests) uses `a` when none is set; a remote target is refused until one is, because two
machines on one letter reset and sign in the same accounts.


`run` takes `mkdir <staging>/.lock-<target>-<slot>` with the owner pid inside; a lock whose owner is gone is taken
over; `--wait m` waits up to `m` minutes. Orphan secret files of dead pids are swept at start.
