# Running

## The commands

| Command | What it does |
|---|---|
| `credless init [--yes]` | writes `credless.config.ts`, `personas.yaml`, `e2e/example.spec.ts`, an `AGENTS.md` snippet, a Cursor rule, a workflow and a suggested settings snippet |
| `credless doctor [--target t] [--offline] [--security]` | tools, Node or Docker, browsers, slot, staging permissions, the key source by presence, a target probe without a key; `--security` prints which layers are active. Reads no secret value |
| `credless slot` | print this machine's slot and where it comes from. Setting one (`credless slot <letter>`) is the person's call: each machine has its own letter |
| `credless run --target t [--slot x] [--workers n] [--twice] [--docker\|--native] [--project p] [--wait m] [-- <playwright args>]` | the suite; refuses production and unknown targets; exit 0 pass, 1 fail, 2 usage, 4 evidence unsafe |
| `credless health --target t` | is the test API on: environment, key id, sinks, extensions |
| `credless seed --target t [--workers n]` | create the persona accounts for every namespace ahead of time (a person's command, before a first run) |
| `credless report [list \| summary [runId] \| open [runId] \| compare <runId> <runId>]` | list the kept runs with their verdicts; print `SUMMARY.md` or open the HTML report (the latest run when none is named); write `FLAKES.md` between two runs |
| `credless evidence scrub\|scan <dir>` | the evidence pipeline by hand, on a folder you own |
| `credless check-tests [dir]` | the test-code gate: no browser launches, no network or file modules, no `fetch()`, no `process.env` in test code |
| `credless demo [--headed]` | starts the kit's demo app and runs its suite: no key, no network, a contact sheet at the end |

`credless help <command>` prints any command's options and examples. Playwright options go after `--`: `credless run --target staging -- -g W3 --project desktop`. The runner also
accepts `-g <pattern>` directly.

## Who runs what

| Situation | What happens |
|---|---|
| any machine, no key | `credless demo` and the kit's self-tests: nothing secret, nothing remote |
| `credless doctor --target t` says the key source is present | you run `credless run --target t -g <case>` yourself. The CLI reads the key from the key source, hands it to the broker in a 0600 file it deletes at once, unsets it, and never prints it. You never read, print or pass it |
| doctor says the key source is missing, needs a person (an interactive sign-in to a secret manager, a hardware prompt) or is out of your session's reach | hand the person the exact command (`credless run --target t -g <case>`) to run in their own terminal, and wait. When they say it finished, read `reports/<run id>/SUMMARY.md`. Never ask for the key, and never work around a missing key source |
| CI | the kit's GitHub Action, with the key as an environment secret passed to the one `run` step; slot `z` |

Never run `playwright test` against a remote target: it would skip the key handover, the namespaces, the slot
lock and the evidence pipeline. Never put the key in a file, an environment variable you export, a command line or
a chat. If the run stops at "no key source" or "no slot", tell the person what is missing; the fix is theirs.

## Slots

A slot is one letter that says whose persona accounts a run resets and signs in (`a0.owner` = slot `a`, worker 0).
It comes from `--slot`, then `CREDLESS_SLOT`, then the machine's slot file (`credless slot` prints which). A local
target uses `a` when none is set; a remote target is refused until the machine has one; CI uses `z`. The run lock (one run per target
and slot) only covers one machine, so two machines on one letter end each other's sessions: a project that runs
from several machines gives each its own letters, and you use only the ones given to the machine you run on. Two
agents on one machine use two letters. `credless health` touches no account and needs no slot.

## Where things land

- While a run is live: a private 0700 staging directory (`~/.cache/credless/staging` on POSIX,
  `%LOCALAPPDATA%\credless\staging` on Windows, or `CREDLESS_STAGING_DIR`). It holds the unscrubbed evidence and,
  for seconds, the key handover file. It is not yours to read; the plugin's hook refuses commands that try.
- After post-run: `reports/<run id>/` (`evidence.reportsDir`), scrubbed, scanned and complete, or nothing at all.
- The run log names the run id and the path of `SUMMARY.md` in its last lines.

## Before the first real run on a target

1. `credless doctor --target t` ends with `ready`.
2. `credless health --target t` reports `enabled`, an environment, a key id and every sink `true`. A sink `false`
   means the backend would deliver mail, pushes or analytics for test accounts to real systems: the run refuses to
   start, and that is the backend team's item.
3. If health answers 404, the backend's test API is not on that target yet (the backend brief says what it must
   implement): that is the gap, not something to work around.

## Useful flags

`--twice` (flake check, writes `FLAKES.md`), `--workers 2`, `--project desktop` (one browser project for a first
look), `--wait 30` (wait up to 30 minutes for the slot's lock), `--native` (no Docker even when it is there),
`CREDLESS_TRACE=on` (traces of passed tests too), `CREDLESS_A11Y=gate` (serious and critical axe findings fail).

## Changing the framework itself

Run the kit's own checks (type check, lint, unit tests, the self-tests through the runner) before a commit; the
self-tests prove the framework against the demo app, the real suite proves the app.
