// The runner's one switchboard for modules other tasks write concurrently (Tasks 1, 3 and 7). Today every line points
// at a typed stand-in under ./_stubs/; wiring the real module in is a change to the import path on that line and
// nothing else. The stand-ins' README lists the real path for each.
export { startBroker } from './_stubs/broker.ts';
export { loadCatalog } from './_stubs/catalog.ts';
export { loadRunConfig, namespaceFor, newRunId } from './_stubs/config-load.ts';
export { Control } from './_stubs/control.ts';
export { writeTemplates } from './_stubs/init.ts';
export { createKeySource } from './_stubs/key-source.ts';
export { mailSinkFor } from './_stubs/mail.ts';
export type { PostRunOptions } from './_stubs/post-run.ts';
export { postRun } from './_stubs/post-run.ts';
export { Redactor } from './_stubs/redactor.ts';
export { compare, summary } from './_stubs/report.ts';
export { scan, scrub } from './_stubs/scrub-scan.ts';
export { runnerKeyFromRunner, Secret } from './_stubs/secret.ts';
export { TestApiClient } from './_stubs/test-api-client.ts';
