# Evidence

A run leaves `reports/<run id>/` (the run id is a UTC stamp plus four random characters, `20261018T101500Z-ab12`).
The folder exists only when the pipeline finished: scrub, scan, quarantine, reports, marker, move.

## Layout

```text
reports/<run id>/
  SUMMARY.md            the verdict, totals, failures to triage, scan result, contact sheets, duration
  COVERAGE.md           one row per about(source, expected): which case each test proves, with its outcome per browser
  FLAKES.md             --twice only: tests whose outcome differed between the two runs
  QUARANTINED.md        only if a file was deleted because a finding survived the scrub
  run.json              run metadata: target, endpoints, slot, versions, git sha, health, cleanup result, exit code; no secrets
  suite.json            Playwright's own exit code, kept apart from post-run's verdict
  scan.json             files scanned, findings by file and kind (never a value), quarantined files
  contact-sheets/contact-sheet-<project>.png     every screenshot of the run, labelled, one sheet per browser project
  shots/<case>--<persona>-<step>-<project>.png   the screenshots; -FAILED- as the step is a triage shot
  aria/<case>--<persona>-<step>.yaml             aria snapshots: agent-readable, scrubbable text
  html/  junit.xml  results.json  ctrf.json  blob/report.zip
  artifacts/<test>/trace.zip (scrubbed)  artifacts/<test>/error-context.md (scrubbed)
```

## Reading `SUMMARY.md`

Top to bottom: **verdict** (`pass`, `fail`, `unsafe`) and the exit code; **totals** (total, passed, failed, flaky,
skipped, expected failures); **failures to triage**, each with the test title, the project and its triage shot;
**scan** (`clean`, or `findings` with the count of quarantined files and of leaked values; any leaked value above 0
is a `fail`); the **contact sheets**; `--twice` adds the flake comparison. One minute is enough to decide whether to
look further.

## Reading the contact sheet

One PNG per browser project, every screenshot in run order, each labelled with the test and the step. Password fields,
`[data-sensitive]`, `evidence.maskSelectors` and every code in play are `#FF00FF` blocks: that is the mask working, not
a rendering bug. Look for the screen you expect at each step, for the persona's name in the header (first names are
unique in the catalog for this reason), and for anything that looks like a code or a token that is not masked (it
should not exist; if it does, it is a bug report with the shape, never the value).

## Triage

1. Open the failing test's triage shot (`-FAILED-` in the name) and its `error-context.md`.
2. Read the guard attachments: `<persona>-outside` (a host nobody listed), `<persona>-api-errors` (an API answer with
   an error code), `<persona>-third-party` and `<persona>-dev-hosts` (listed traffic), `test-api-calls` (method, path,
   status and time per call).
3. Decide: an app bug (the server or the screen did the wrong thing; report it with the shot), a test bug (a wrong
   expectation; fix the test, never by weakening it until green), an environment problem (the target was down, a sink
   was off; `health` tells), or a flake (`--twice` shows a different outcome; report it as flaky, do not retry).
4. A failure whose cause is an unexpected error status is often an expected one that lacks its declaration:
   `guard.expectStatus(url, status)` with the reason in the test title.

## What is not in the evidence

The runner key (never), the broker token (scrubbed), session cookie values (scrubbed; the scan fails the run on a
survivor), one-time codes (masked and scrubbed), the sign-in password (scrubbed), screencast frames (traces carry
none), real people (personas are synthetic). What the scan cannot see: text inside an image. A screen that shows a
code must be masked by selector; a code shown one digit per box is not recognised as a code and needs `shot({ mask })`.

## Retention

`reports/` on a machine is yours to clean. The GitHub Action keeps the artifact 14 days by default; anyone with read
access to the repository can download it.
