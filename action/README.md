# credless GitHub Action

Runs a credless suite in CI: `doctor`, then `run`, then the evidence as an artifact, `SUMMARY.md` in the job summary
and one comment on the pull request. The action exits with the CLI's code (0 pass, 1 fail or a leaked secret value,
2 usage, 4 evidence unsafe and deleted).

```yaml
name: e2e
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  e2e:
    runs-on: ubuntu-latest
    environment: e2e-dev # holds CREDLESS_RUNNER_KEY as an environment secret, with required reviewers
    permissions:
      contents: read
      pull-requests: write # the one upserted comment
    container:
      image: mcr.microsoft.com/playwright:v1.64.1-noble # pin by digest in your repo
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci --ignore-scripts
      - uses: Prathyush-KKK/credless/action@v0.1.0 # pin to a release tag or a SHA
        with:
          target: dev
          key: ${{ secrets.CREDLESS_RUNNER_KEY }}
          install-browsers: 'false' # the Playwright image has them
          twice: 'false'
```

`npx credless init` writes a workflow like this into `.github/workflows/e2e.yml`.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `target` | required | a key of `targets` in `credless.config.ts`. Production targets are refused by the CLI. With `command: demo` it only names the artifact |
| `command` | `run` | `run` runs `credless run --target <target>`; `demo` runs `credless demo` (starts the bundled demo app and its quickstart suite, no key), which is how this repository dogfoods the action |
| `key` | `''` | the test-API runner key, from an environment secret. Empty for the demo |
| `slot` | `z` | the agent slot letter; CI uses `z` so it never collides with a person's slot |
| `grep` | `''` | run only tests whose title matches (Playwright `--grep`) |
| `twice` | `'false'` | run the suite twice and write `FLAKES.md` instead of retrying |
| `workers` | `''` | worker count; the config's default when empty |
| `node-version` | `'24'` | for `actions/setup-node`; the package needs 24.12 or later |
| `config` | `''` | path of the config file when it is not `credless.config.ts` in the working directory |
| `install-browsers` | `'true'` | install Chromium with system dependencies; `'false'` inside the Playwright image |
| `working-directory` | `'.'` | the project directory with the config and the installed `credless` dependency |
| `retention-days` | `'14'` | how long the evidence artifact is kept |
| `reports-dir` | `reports` | where the kept evidence lands, relative to the working directory (`evidence.reportsDir`); `apps/demo/reports` for the demo in this repository |

## Outputs

| Output | Meaning |
|---|---|
| `verdict` | `pass`, `fail`, `usage` or `unsafe` |
| `summary-path` | path of the kept `SUMMARY.md`, or empty |
| `exit-code` | the CLI's exit code |

## Where the key goes

The `key` input is set as `CREDLESS_RUNNER_KEY` in the environment of the one `run` step, and nowhere else: not in
`doctor`, not in the upload, not in the summary step. The CLI takes it over from its environment, deletes it from its
own environment, and hands it to the run's global setup as a 0600 file that is read once and deleted; the broker
holds it in memory until teardown. Workers, browsers and the evidence never see it (self-test B01).

An environment secret is masked in logs, not hidden: anyone who can edit a workflow that runs in that environment can
read it. Put the key in an environment with required reviewers and a deployment branch rule. OIDC key sources that
remove the static secret are on the roadmap (v0.3).

## What is kept, and who can read it

`reports/` is uploaded as `credless-reports-<target>-<run id>-<attempt>` and kept `retention-days` days. Its content
was scrubbed and scanned before the kit moved it out of staging (a secret value fails the run; evidence that was not
fully processed is deleted and nothing is uploaded). Anyone with read access to the repository can download an
artifact; decide retention accordingly.

## The PR comment

On `pull_request` events the summary step looks for a comment whose body starts with `<!-- credless -->` and updates
it, or creates one. It uses the workflow's own token through the REST API; no third-party action is involved. On a
pull request from a fork the token is read-only and the comment is skipped with a note; the job summary carries the
same content. The comment is `SUMMARY.md` as the kit wrote it, with the exit code and links to the artifact and the
run; the script adds nothing else from the environment.

If you emit CTRF (`playwright-ctrf-json-reporter` is an optional dependency the kit uses when installed),
`ctrf-io/github-test-reporter` is a documented alternative for richer PR reporting; the scan covers `ctrf.json` too.

## Dogfood

`.github/workflows/demo-e2e.yml` in this repository runs this action with `command: demo` on every push and pull
request, with no key configured anywhere: `credless demo` starts the demo app, runs the quickstart suite against it
and leaves the evidence under `apps/demo/reports/`.
