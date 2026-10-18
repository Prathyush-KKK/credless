# Task 4 stand-ins

Typed stand-ins for modules other tasks write concurrently. `../deps.ts` is the only file that imports them; wiring the
real modules in is a change to `deps.ts` alone (one import line per module). Every stand-in mirrors the frozen
signature where one exists (`src/config/index.ts`, `src/adapters/index.ts`) and the plan's names otherwise.

| Stand-in | Real module (task) | Exports |
|---|---|---|
| `secret.ts` | `src/core/secret.ts` (1) | `Secret`, `runnerKeyFromRunner`, `registeredSecrets` |
| `config-load.ts` | `src/config/load.ts` (1) | `loadRunConfig`, `newRunId`, `namespaceFor` |
| `key-source.ts` | `src/adapters/key/index.ts` (1) | `createKeySource` |
| `broker.ts` | `src/core/broker.ts` (1) | `startBroker` |
| `test-api-client.ts` | `src/core/test-api-client.ts` (1) | `TestApiClient` |
| `control.ts` | `src/core/control.ts` (1) | `Control` |
| `catalog.ts` | `src/core/catalog.ts` (1) | `loadCatalog` |
| `mail.ts` | `src/adapters/mail.ts` (1) | `mailSinkFor` |
| `post-run.ts` | `src/evidence/post-run.ts` (3) | `postRun` |
| `redactor.ts` | `src/evidence/redactor.ts` (3) | `Redactor` |
| `report.ts` | `src/evidence/report.ts` (3) | `summary`, `compare` |
| `scrub-scan.ts` | `src/evidence/scrub.ts`, `scan.ts` (3) | `scrub`, `scan` |
| `init.ts` | `src/templates/index.ts` (7; returns `WriteResult`, the stand-in returns the written paths) | `writeTemplates` |

Delete this folder once `deps.ts` imports nothing from it.
