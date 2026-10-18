# Quickstart: signed-in Playwright tests without credentials

## The demo, 30 seconds

```sh
npm i -D credless @playwright/test
npx playwright install chromium    # once, if Playwright's browsers are not installed yet
npx credless demo
```

Node.js 22.18 or later. The command starts the bundled demo app (a small "documents for teams" app with its own test
API, in memory; nothing else on your machine), runs the quickstart suite with two and three signed-in browsers per
test, and prints the path of the evidence folder (`credless-demo/reports/<run id>/` in the directory you ran it from;
`apps/demo/reports/` in a checkout of the repository).

Open `reports/<run id>/SUMMARY.md`: the verdict, the totals, failures to triage with their screenshot, the scan result
("clean", or the file and the kind of finding, never a value). Open `reports/<run id>/contact-sheets/`: one PNG per
browser project with every screenshot the run took, labelled by test and step, codes and password fields masked.

The suite you just ran is `apps/demo/e2e/*.spec.ts` in the repository: W1–W4 (workspaces: invite, join, outsider sees nothing, removed
member loses access). Read one; it is the shape of every test you will write.

The acceptance test for a kit like this is "plant a secret, watch the run fail":

```sh
npx credless demo --plant-secret
```

One extra spec writes the demo's stand-in sign-in password into the test output on purpose. The scrub redacts it,
the scan counts it, `SUMMARY.md` says `LEAK`, the run exits 1, and the command reports that the protection worked
(it exits 0 only in that case). The self-tests do the same against a real HTML report, inside its embedded zip.

## Your app

### 1. Initialise

```sh
npm i -D credless @playwright/test   # Playwright 1.64 or later; install with --ignore-scripts, nothing here needs a script
npx credless init
```

`init` writes `credless.config.ts`, `personas.yaml`, `e2e/example.spec.ts`, a 25-line `AGENTS.md` snippet, a Cursor
rule (`.cursor/rules/e2e-testing.mdc`), a GitHub workflow (`.github/workflows/e2e.yml`) and a suggested
`.claude/settings.json` deny block. Nothing it writes contains a secret. In a CommonJS project (a package.json
without `"type": "module"`, which is what `npm init -y` makes) the TypeScript files are written as `.mts`
(`credless.config.mts`, `playwright.config.mts`, `e2e/example.spec.mts`): Node and Playwright run `.mts` as an ES
module either way, while a `.ts` there would be compiled as CommonJS and fail.

### 2. Adapt the config

[Every field is documented](configuration.md). The ones you will change on day one:

```ts
import { defineConfig } from 'credless/config';

export default defineConfig({
  targets: {
    dev: { web: 'https://dev.app.example.com', api: 'https://dev.api.example.com' },
    staging: { web: 'https://staging.app.example.com', api: 'https://staging.api.example.com' },
  },
  production: { domains: ['example.com'], nonProductionPattern: '^(dev|staging)\\.' },
  hosts: { thirdParty: ['*.googleapis.com'], analytics: ['*.googletagmanager.com'] },
  personas: { catalog: './personas.yaml', addressPattern: '^qa\\+[a-z0-9-]+@example\\.com$' },
  key: process.env.CI ? { source: 'env' } : { source: 'exec', preset: 'op', ref: 'op://Dev/credless/runner-key' },
  signals: { sessionCookies: ['sid'] },
});
```

A config whose production rules and target hosts overlap is refused at load. `production.words` defaults to
`['prod', 'production']`: any host with one of those as a label is production, anywhere.

### 3. Give the backend the test API

Seven routes behind five locks: the [backend brief](../../contract/BACKEND-BRIEF.md) is the hand-over document for
your backend team, and the demo app is a complete reference. A Node backend can mount `createTestApi()` from
`credless/server` and implement the state callbacks. Until the test API exists on dev, `credless health --target dev`
tells you what is missing.

### 4. Run

```sh
npx credless doctor --target dev     # tools, browsers, slot, staging permissions, key source by presence, target probe; reads no secret
npx credless health --target dev     # the test API is on; every sink is wired
npx credless run --target dev        # the suite on your slot
npx credless run --target dev --twice -- --grep "W3"   # some tests, twice, with FLAKES.md
```

`run` refuses production and unknown targets, takes a lock per target and slot so two runs do not share accounts,
reads the key through the configured source, hands it to the broker and never to a worker, and leaves
`reports/<run id>/` only after the evidence was scrubbed and scanned. Exit codes: 0 pass, 1 fail or a leaked value,
2 usage, 4 evidence unsafe (deleted).

### 5. Let the agent write tests

Install the skill ([agents](agents.md)) and ask for a feature to be tested. The method it follows: expected
behaviour first, a case list, the cheapest layer that proves each case, tests with `personas` and `control`, a run,
and a judgement of the evidence. It never retries a flaky test into green and never runs against production.

### 6. CI

The [GitHub Action](../../action/README.md): the key as an environment secret passed to the one `run` step, the
evidence as an artifact, the verdict as one PR comment. Any other CI works the same way: `npx credless run --target
<t>` with the key in a protected variable (`key: { source: 'env' }`), and the `reports/` folder kept as an artifact.
[docs/ci](../ci/) has two ready-to-copy GitHub workflows.
