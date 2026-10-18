# The demo app

A deliberately small "documents for teams" app: `node:http`, one HTML file, in-memory state. People sign in by cookie
(`sid`, HttpOnly, plus a CSRF double-submit cookie `csrf` with the `X-CSRF-Token` header on every mutation).
**Workspaces** have an **owner**, **members**, read-only **guests** and a join link with a six-digit code; five wrong
codes lock the link. **Documents** belong to a workspace; search is scoped to what you can see; removing a member
revokes access on the spot. Nothing here is a real backend, and nothing in it is a secret.

It exists for four reasons:

1. **The reference test-API server.** `src/test-api.ts` wires the kit's `createTestApi()` (`credless/server`) to
   the demo's state: the seven core routes of `contract/core.openapi.yaml` in about forty lines of seams
   (`personas.ensure/reset/state`, `session.mint/revoke`, `mail.list`, `cleanup`, `isTestAccount`), plus the
   extension routes of `contract/demo.openapi.yaml` under the same base path. A backend team reads that one file.
2. **The quickstart suite** in `e2e/`: `credless.config.ts`, `personas.yaml`, `demo.control.ts` (the extension
   pattern: `DemoControl extends Control` with `workspace()`), and the specs W1–W4, F01–F04 and S1.
3. **The kit's self-tests.** The `/__demo/*` pages misbehave on purpose (a console error, a request to an outside
   host, to production, to analytics, an expired session, an HTTP error, a WebSocket, WebRTC, redirects out) and two
   sentinels on fixed ports (TCP `127.0.0.1:4319`, UDP `127.0.0.1:3478`) count anything that leaks past the guard
   and the egress proxy. `docs/conventions.md` §10 is the route table.
4. **The demo GIF** of the README, recorded against it.

## Running it alone

```sh
node apps/demo/src/server.ts
# ready web=http://127.0.0.1:41273 api=http://127.0.0.1:35891
```

Plain Node 22.18+ or 24, no build, no dependencies beyond `node:` and the kit's source. Flags: `--web-port N`,
`--api-port N` (default: ephemeral), `--no-sentinels` (a second demo on the same machine), `--no-test-api` (the
flag-off case of the backend brief: `/_test/*` is a plain 404). The one line it prints is what Playwright's
`webServer.wait` regex reads. `SIGTERM` stops it.

The runner key the test API expects is a **stand-in, never a real secret**. It comes from, in order: a fresh random
key written (mode 0600, never overwriting) to `--write-key PATH`, so the kit's `selftest` and `demo` targets read the
same file through `CREDLESS_DEMO_KEY_FILE`; the file that variable names, when a demo started by hand should reuse
one; or `src/fake-secrets.json`. The sign-in persona's password is the other
stand-in in that file; the harness hands it to the one UI sign-in test as `CREDLESS_SIGNIN_PASSWORD`. The kit's
evidence scan treats both exactly like real secrets: a self-test that leaks either fails the run.

Try it by hand (the key here is the fallback from `fake-secrets.json`):

```sh
API=http://127.0.0.1:35891
curl -s $API/_test/health                                   # 401 {"error":{"code":"bad-key",...}}
curl -s -H 'X-Test-Runner-Key: demo-runner-key-7c1e4b9a2d6f8035' $API/_test/health
curl -s -H 'X-Test-Runner-Key: ...' -H 'content-type: application/json' $API/_test/personas/ensure \
  -d '{"personas":[{"handle":"a0.owner","email":"qa+a0-owner@example.com","displayName":"Ada QA-a0","attributes":{"role":"owner"}}]}'
curl -si -H 'X-Test-Runner-Key: ...' -H 'content-type: application/json' $API/_test/session \
  -d '{"handle":"a0.owner","runId":"20261018T120000Z-ab12"}'      # Set-Cookie: sid=...; HttpOnly
```

`apps/demo/test/test-api.test.ts` is the same sequence as a test (spawns the server, asserts every answer).

## Routes

Web origin (`src/app.html`, client-side routes): `/login`, `/` (home and workspaces), `/w/:id`, `/w/:id/members`
(invite form, `Remove <name>` buttons for the owner), `/w/:id/link` (the link and the code, owner only), `/d/:id`
("Not found" for anyone who may not see it), `/search` (its icon button has no name on purpose: axe reports it, the
run keeps the finding), `/j/:token` (the join landing: `You're in <workspace>`, `That code doesn't match. N tries
left.`, `Joining is locked.`), and the `/__demo/*` pages.

Api origin (`src/api.ts`): `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET /api/workspaces`,
`GET /api/workspaces/:id` (404 for non-members), `POST /api/workspaces/:id/invites`, `DELETE
/api/workspaces/:id/members/:userId`, `GET /api/documents/:id` (404 for non-members), `GET /api/search?q=`,
`GET|POST /api/join/:token`; the self-test routes `/__demo/not-here`, `/__demo/api-redirect`, `/__demo/state`
(counts and the audit tail, never a cookie or a code) and `/api/expired-on-purpose` (401, the sign-out signal); and
the test API under `/_test` (`src/test-api.ts`).

## Checks

- `node scripts/contract-check.ts` (repo root): the kit's client routes, the two contracts and this server agree.
- `node scripts/catalog-check.ts`: `e2e/personas.yaml` validates and is printed as the runner creates it.
- `tsc --noEmit -p apps/demo`, `biome check apps/demo`.
