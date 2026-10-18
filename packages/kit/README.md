# credless

**Signed-in, multi-user Playwright end-to-end tests that AI coding agents can run without your credentials.**

credless is a Playwright toolkit for authenticated E2E testing on dev or staging. Synthetic personas get real
accounts minted server-side by a locked test API, a loopback broker holds the only key so it never reaches your test
code, the browsers or a coding agent (Claude Code, Cursor, Codex), every browser runs behind an egress proxy that
refuses production, and the run fails if a secret value survives in a trace, screenshot or report.

![credless contact sheet: every screenshot of a demo run, labelled by test and persona, codes and password fields masked](https://raw.githubusercontent.com/Prathyush-KKK/credless/main/docs/media/contact-sheet.png)

## Try it in 30 seconds

```sh
npm i -D credless @playwright/test
npx playwright install chromium     # once, if Playwright's browsers are not installed yet
npx credless demo                   # bundled demo app, two and three signed-in browsers per test, a contact sheet
npx credless demo --plant-secret    # plant a stand-in secret on purpose and watch the run fail on the leak
```

## Use it on your app

```sh
npx credless init                   # credless.config.ts, personas.yaml, an example spec, AGENTS.md snippet, Cursor rule, CI workflow
npx credless doctor --target staging
npx credless run --target staging
```

```ts
import { expect, test } from 'credless';

test('an outsider never sees the team document', async ({ personas, control }) => {
  const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } });
  const [guest] = await personas.open('guest');            // a signed-in browser, no password anywhere
  await guest.goto(ws.document(0).path);
  await expect(guest.page.getByText(ws.document(0).title)).toHaveCount(0);
  await guest.shot('outsider-document');                   // masked, scrubbed and scanned before it is kept
});
```

## What you get

- **Personas, not passwords**: one real account per persona per parallel worker; several signed-in users in one test.
- **A locked test API**: seven routes behind five server-side locks; the OpenAPI contract, a backend brief and a
  reference server (`credless/server`) ship with the package.
- **A key broker**: the key is read once (env, file, OS keyring, `op`, `infisical`, `doppler`, `vault`, `kubectl`)
  and lives only in a loopback broker.
- **An egress proxy per browser**: production and unlisted hosts refused before any connection, redirects,
  WebSockets and WebRTC included; DNS pinned; private addresses refused; a canary proves the proxy is in the path.
- **Leak-proof evidence**: scrubbed in four encodings (zips inside the HTML report included), scanned, fail closed;
  `SUMMARY.md`, a coverage table, a flake report and a contact sheet per browser.
- **Agent surfaces**: an Agent Skill, a Claude Code plugin with a secret-blocking hook, a Cursor rule, an `AGENTS.md`
  snippet, and a GitHub Action.

## Requirements and exports

Node.js 22.18 or later; peer `@playwright/test` 1.64 or later; no install scripts (`--ignore-scripts` works).

| Import | What it gives you |
|---|---|
| `credless` | `test`, `expect`, `about`, `typeSecret`, `clearSecretField`, `see`, `notSee`, `Secret`, types |
| `credless/config` | `defineConfig`, `kitPlaywrightConfig` |
| `credless/adapters` | the adapter interfaces, `Control`, the built-in key, session and mail adapters |
| `credless/server` | `createTestApi`, the reference test-API handler for Node backends |
| `credless/cli` | the CLI entry |

## Security, honestly

credless is not a security boundary: the boundaries are the broker process that holds the key and the test API's
locks on your server; the rest is defence in depth with a self-test per layer. The threat model, the claims we make
and the ones we do not:
[SECURITY.md](https://github.com/Prathyush-KKK/credless/blob/main/SECURITY.md).

## Links

- Documentation, backend brief and the GitHub Action: https://github.com/Prathyush-KKK/credless
- Issues: https://github.com/Prathyush-KKK/credless/issues
- License: Apache-2.0. Built and maintained by an independent developer, [Prathyush K](https://github.com/Prathyush-KKK).
