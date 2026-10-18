# credless

Signed-in, multi-user Playwright E2E your coding agent runs without the key.

A Playwright layer for end-to-end tests of signed-in, multi-user flows against dev or staging: synthetic personas with
one real account per parallel worker, sessions minted server-side by a locked test API, a loopback broker so the
test-API key never reaches the test code or the browser, an egress proxy per browser that refuses production and
unlisted hosts below Playwright routing, and evidence that is scrubbed, scanned and fails the run if a secret value
survives.

```sh
npx credless demo            # the bundled demo app, a suite with two and three signed-in browsers, a contact sheet
npx credless init            # config, persona catalog, example spec, the skill surfaces for your agent
npx credless run --target dev
```

```ts
import { expect, test } from 'credless';

test('an outsider never sees the team document', async ({ personas, control }) => {
  const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } });
  const [guest] = await personas.open('guest');
  await guest.goto(ws.document(0).path);
  await expect(guest.page.getByText(ws.document(0).title)).toHaveCount(0);
  await guest.shot('outsider-document');
});
```

Node 24.12 or later; peer `@playwright/test` 1.64 or later; install with `--ignore-scripts` (nothing here needs
one). Exports: `credless` (test, expect, about, typeSecret, clearSecretField, see, notSee, Secret, types),
`credless/config` (`defineConfig`), `credless/adapters` (the interfaces, `Control`, the built-ins),
`credless/server` (`createTestApi`, the reference test-API handler for Node backends), `credless/cli`.

credless is not a security boundary: the boundaries are the broker process that holds the key and the test API's
locks on your server; the rest is defence in depth with a self-test per layer. The threat model, the claims we make
and the ones we do not: `SECURITY.md` in the repository.

Docs, backend brief, GitHub Action and the skill: https://github.com/Prathyush-KKK/credless. Apache-2.0.
