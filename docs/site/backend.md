# Backend: the test API your dev and staging backend implements

The kit needs seven routes on your backend, dev and staging only, behind five locks. Everything a backend team
needs is in one document: the [backend brief](../../contract/BACKEND-BRIEF.md), with the routes, the locks, session
minting through the real login seam, the sinks, audit and rate limits, run tagging and cleanup, a "done when" list
and per-framework notes for Spring Boot, Rails, Django, Laravel and Next.js.

The contract itself is [`contract/core.openapi.yaml`](../../contract/core.openapi.yaml) (OpenAPI 3.1). The kit's
client routes, the broker's allowlist, the reference server and the demo app are checked against it.

## In one table

| Route | Does |
|---|---|
| `GET /_test/health` | enabled, environment, key id, sinks, extensions |
| `POST /_test/personas/ensure` | create the flagged test accounts that do not exist yet |
| `POST /_test/personas/reset` | put accounts back to their baseline |
| `GET /_test/personas/{handle}` | the server's view of one account |
| `POST /_test/session` | mint a real session through the login seam; `Set-Cookie` as a web login sends it; ≤ 1 h; tagged with the run id |
| `GET /_test/personas/{handle}/messages` | captured mail, links and codes parsed out |
| `POST /_test/runs/{runId}/cleanup` | remove everything tagged with the run; revoke its sessions |

## The five locks

1. A flag, default off; with the flag off the routes do not exist (plain 404).
2. A boot guard that always loads and refuses to start with the flag on in a production or staging profile.
3. The runner key, compared in constant time, with a `_NEXT` pair for rotation; no key configured means 401 everywhere.
4. The test-account flag, set only by `personas/ensure` and only for addresses in the configured pattern; every route
   refuses an account without it.
5. No route outside dev at the ingress: staging and production answer 404 at the edge.

One test checks all five and fails the build when one is missing.

## Reference implementation for Node

```ts
import { createServer } from 'node:http';
import { createTestApi } from 'credless/server';

const testApi = createTestApi({
  key: process.env.TEST_API_RUNNER_KEY ?? '',       // from your secret store; compared in constant time
  environment: 'dev',
  addressPattern: /^qa\+[a-z0-9-]+@example\.com$/,
  sinks: { mail: true, push: true, analytics: true }, // report true only when really wired
  extensions: ['createWorkspace'],
  personas: { ensure, reset, state },               // your store
  session: { mint, revoke },                        // your login seam, and revocation by run id
  mail: { list },                                   // your sink table
  cleanup,                                          // sweep by run id, test accounts only
});

createServer(async (req, res) => {
  if (process.env.TEST_API_ENABLED === 'true' && (await testApi(req, res))) return; // lock 1 stays yours
  app(req, res);
}).listen(3000);
```

`createTestApi()` implements the routes, the key check, the address pattern, the status codes and the audit hook;
the callbacks are the app's state. The demo app (`apps/demo/src/test-api.ts`) is the complete, runnable example.

## Extension routes

An app adds routes under the same base path in its own OpenAPI file and lists their operationIds in
`health.extensions`. On the kit's side, a class extending `Control` calls them:

```ts
import { Control } from 'credless/adapters';

export default class DemoControl extends Control {
  async workspace(spec: { owner: string; members?: string[]; guests?: string[]; documents?: Record<string, number> }) {
    const { data } = await this.api.call('createWorkspace', { body: this.handles(spec) });
    this.track('workspace', data.id); // teardown deletes it, even when the test failed
    if (data.inviteCode) this.secret(data.inviteCode, `workspace ${data.id} code`); // masked and scrubbed
    return new WorkspaceFixture(data, this);
  }
}
```

`config.control.module` points at the class; `control.workspace(...)` is then typed on the fixture. `this.handles()`
maps persona ids to this worker's handles; `this.track()` registers an object for teardown; `this.secret()` wraps a
value the backend handed out so it is masked in every screenshot and scrubbed from every file.
