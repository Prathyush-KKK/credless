# The method, step by step

`SKILL.md` gives the seven steps in short. This file is the long form: what each step produces, what "done" is,
and the mistakes each step exists to prevent. Work through them in order; skipping one is how a green run ends up
proving nothing.

## 1. Expected behaviour first

**Produces:** a short list of expectations, each with its source.

Read what the feature is supposed to do before looking at what it does. Sources, in order of authority:

1. The product spec or design document for the feature, and its decisions log (a decision beats a spec).
2. Manual test cases a person wrote, if any: they are a case list already, in another format.
3. The code: routes, controllers, permission rules, validation, copy keys. An expectation that only the code
   supports is written down as "derived from code: `<file or rule>`", so a person can confirm it before it counts.

Where sources disagree, or nobody has decided, that is a **product question**: write it down as `product:` in the
report and move on. You do not decide product behaviour, and a test that encodes your guess is worse than no test,
because it will stay green when the guess is wrong.

**Done when:** every expectation has a source, and the open questions are listed, not resolved.

## 2. Case list before tests

**Produces:** the table in `case-list.md`, one row per case.

Write it before any test code, in the document that tracks the work. The columns force the questions a test must
answer: which personas, what state the backend must be in first (setup through `control`), what the person does
(steps), what must be true after (expected), and where the proof is cheapest (layer).

Cover, for each feature: the happy path per role; permissions per role, including the roles that must be refused
(an outsider, a removed member, a second workspace's owner); state changes before and after; limits and expiry;
error copy; and effects on other accounts (what everybody else sees after the action).

**Done when:** a person who has not read the spec could run the cases by hand from the table alone.

## 3. The cheapest layer that proves the case

**Produces:** the `Layer` column, filled in.

| Layer | Proves | Costs | Lives in |
|---|---|---|---|
| backend unit or API test | a rule, a validation, a permission check | milliseconds, no browser | the backend's suite |
| component or mocked-server test | a screen's look and states | a browser, no account, no server | the app's own suite |
| end-to-end with personas | cross-account behaviour, the real server, the real session | the most of everything | `e2e/` here |

A case goes to the lowest layer that proves it. "The API refuses a member's delete" is a backend test; "the
member's screen hides the button" is a component test; "after the owner removes them, the member's open page and the
API both say Not found" is end-to-end, because it crosses two sessions and the real server. A feature usually ends
with a handful of end-to-end cases and many lower ones; if every case is end-to-end, the list is wrong.

## 4. Use the framework

**Produces:** tests in `e2e/`, one per case or per small group of cases, each with `about()`.

The shape of every test:

1. `about(source, expected)` first: it fills the coverage table, and it makes you state the expectation again.
2. Setup through `control` in one call (the app's extension method, or the core `ensure`/`reset`/`state`), never
   through the UI unless the UI is what the case tests.
3. `personas.open(...)` once, for every persona the case needs, in one call. Two personas means two browsers.
4. The behaviour under test, in the real UI, through Playwright locators (`getByRole`, `getByText`, `getByLabel`).
5. The checks: on the screen (`expect(...)`), and on the server (`session.api(path)`, `control.state(id)`).
6. `shot()` on every browser that showed a screen, right after its checks. Name the step after what the screen
   shows (`document-after`), not after the test's phase (`step3`).

What the fixtures do for you, so you do not do it again: sign-in (a session minted through the test API, no
password), the guard (console errors, failed requests, HTTP errors, unexpected sign-outs, production and unlisted
hosts), the egress proxy per browser, masking of password fields and of every code in play, teardown of what was
created, reset of what was touched, revocation of the run's sessions.

What the fixtures cannot do for you: decide what the expected result is; notice that the screenshot shows the
wrong screen (that is step 6); know that a status is expected. Tell the guard with `guard.expectStatus(url, status)`
or `guard.allowConsole(pattern, reason)`, always with the reason in the title or the argument.

## 5. Running

**Produces:** a run id and `reports/<run id>/`.

Always through the CLI (`credless run --target <t>`), never `playwright test` against a remote target: the CLI is
what takes the key from the key source, hands it to the broker, unsets it, sets up the persona namespaces, locks the
slot, and scrubs and scans the evidence before keeping it. Running Playwright directly skips every one of those.

Before the first real run on a target: `credless doctor --target <t>` (reads no value, starts nothing) and
`credless health --target <t>` (the test API answers, names its environment and key id, and reports every sink
`true`). If health fails, the backend's test API is not on that target yet: that is the finding, not something to
work around.

If the key source needs a person (`doctor` says so, or the command stops at "no key source"), hand the person the
exact command and wait; `running.md` has the table of who runs what.

## 6. Judging

**Produces:** the report in `evidence-and-triage.md`, with one triage category per failure.

Order: `SUMMARY.md` (verdict, totals, failures, a `LEAK` or `unsafe` line comes before everything else), then the
contact sheets (does every screenshot show what its name says, for the persona it names?), then `COVERAGE.md`
(every case has a row; every skip says why), then the traces of the failures.

A passing test is not evidence by itself. The evidence is the screenshot that shows the expected screen, the
server's answer that agrees with it, and the coverage row that ties both to a source. Identical screenshots of
different steps, a boot cover, a blank page, a sign-in screen or another persona's name are each a reason to call
the test not proven, whatever its status says.

## 7. Agents

**Produces:** a split of the work, and a reviewer's findings next to the run's own.

Split a large feature by area, one sub-agent per area, one slot per agent (`agents.md`). Each agent runs the whole
method for its area, including its own case list. Before anything is reported as passing, a reviewer that did not
write the tests reads the evidence against the case list and challenges it; the reviewer's findings go into the
report unchanged.

## The loop

A finding of category **test bug** sends you back to step 4; **environment** to step 5, after the cause is fixed;
**spec question** to step 1, as a `product:` item; **app bug** goes into the report as a `code:` item with the case,
the screenshot path, and expected versus seen. No category sends you back to "run it again and see".
