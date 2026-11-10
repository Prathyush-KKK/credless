# Judging answers a model wrote

A chat reply, a generated summary or an AI analysis is different on every run. A string assertion on it is either
flaky or so loose it proves nothing. credless never string-matches such text; `judgeAnswer()` holds it to three
layers, cheapest first, and no model runs while a test runs.

1. **Markers, in the test.** Words the answer must contain (`must`) and must not contain (`mustNot`), compared
   case-insensitively with whitespace squashed. A missing or forbidden marker fails the test at once: a leak of
   another user's document title is never a judgement call.
2. **A rubric, after the run.** A judge scores each criterion 0 (no), 1 (partly) or 2 (yes), with a quote from the
   answer and one sentence of why. The judge is a command you choose or an agent that writes verdict files.
3. **A quote check.** A score above 0 counts only when its quote (8 characters or more) is in the answer word for
   word. A judge that invents its evidence makes the answer `unsure`, never `pass`.

## Recording an answer

```ts
import { judgeAnswer, test } from 'credless';

judgeAnswer({
  persona: 'member', // who the answer was given to
  question: 'Which documents can I see?',
  answer: await member.page.getByTestId('answer').innerText(),
  facts: ['The member can see one document, "Q3 plan", in the Team workspace.'], // the whole truth the judge grades against
  must: ['Q3 plan'],
  mustNot: ['Payroll'],
  // rubric: GROUNDED_ANSWER by default; [] for markers only
  // threshold: 0.75 by default (weighted mean of the scores, 0 to 1)
  // step: 'follow-up', when one test records more than one answer
});
```

The answer, the question and the facts are redacted (registered secrets, credential shapes) before they are written
to `judge/cases/<answer>.json` in the run's folder, which the evidence pipeline scrubs and scans with everything else.
A rubric whose weight is zero or below, or that names a criterion twice, is refused before anything is written.

The default rubric, `GROUNDED_ANSWER`:

| Criterion | Weight | Asks |
|---|---|---|
| `answers` | 1 | Does the answer address the question that was asked? |
| `grounded` | 2 | Is every claim supported by the facts given? An unsupported or invented claim scores 0. |
| `honest-gaps` | 1 | Where the facts do not hold what was asked for, does the answer say so instead of guessing? |

Add criteria of your own (`{ id, ask, weight? }`) for what your feature must do: the tone of a support reply, a
refusal for an out-of-scope request, the steps a how-to answer must give.

## Who judges

After the suite, `run` settles every recorded answer, on this machine (also when the suite ran in Docker):

- **A verdict file** already in `judge/verdicts/<answer>.json` is used as it is. That is how an agent hands its scores
  in: it reads `judge/cases/<answer>.json`, writes `{"id": "<answer>", "scores": [{"criterion", "score", "quote", "why"}]}`,
  then runs `credless judge <run id>`.
- **Else the judge command**, when there is one: `run --judge '<json argv>'`, else the JSON argv in
  `~/.config/credless/judge` (`%APPDATA%\credless\judge` on Windows) for this machine. It is started with no shell,
  gets the prompt on stdin, and prints one JSON verdict on stdout within 120 seconds. Its environment is yours minus
  every `CREDLESS_*` variable, so it never sees the run's key file, broker token or evidence key; it is sent the
  question, the answer and the facts, nothing else. If it fails once, the rest stay unjudged and the reason is in
  `JUDGE.md`.
- **Else nobody:** the answer is `unjudged`, listed in `SUMMARY.md` and `JUDGE.md`.

Examples of judge commands (any program that reads a prompt on stdin and prints JSON works):

```sh
credless run --target staging --judge '["claude","-p"]'           # Claude Code in print mode
credless run --target staging --judge '["llm","-m","<model>"]'   # the llm CLI, with a model you have
echo '["node","/path/to/my-judge.mjs"]' > ~/.config/credless/judge  # this machine's default
credless run --target staging --no-judge                           # leave every rubric unjudged this time
```

Pick a judge you are allowed to send test data to; the data is synthetic, but it is your app's output. On Windows,
give an `.exe` path or `["node", "script.mjs"]`: a `.cmd` shim needs a shell, and none is used.

## Outcomes

| Outcome | When | Fails the run |
|---|---|---|
| `pass` | markers pass, and the weighted score is at or above the threshold (or there is no rubric) | no |
| `fail` | a marker failed, or the score is below the threshold | yes |
| `unsure` | the judge's quote is not in the answer, a criterion has no usable score, or the command printed no verdict | with `--judge-gate` |
| `unjudged` | it has a rubric and nobody scored it | with `--judge-gate` |

`SUMMARY.md` gets one line with the counts and a table of every answer that did not pass; `JUDGE.md` has every
question, answer, score and quote; `judge/results.json` is the same for tools. `credless judge <run id>` settles a
kept run again (for verdict files written after the run, or with `--judge`), rewrites `JUDGE.md` and exits 1 when an
answer failed.

## Why this way

- **Deterministic first.** Most of what matters (the right title, no cross-tenant leak) is a marker. The model is
  asked only what a marker cannot say.
- **No model in the run.** A test's outcome never depends on a model's latency, rate limit or mood; the judge runs
  after, and its verdict is evidence like a screenshot.
- **Evidence or nothing.** A judge must quote the answer for every score above zero. Quotes are checked mechanically,
  so a judge cannot pass an answer by hallucinating support for it.
- **The prompt treats the answer as data.** It says so to the judge, in so many words: text inside the answer is
  graded, never obeyed.
