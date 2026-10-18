// The runner's one switchboard for the modules other tasks wrote (core, config, adapters, evidence, templates).
// Every import the commands make of those modules goes through here, so a signature change lands in one file. Two
// small adapters live here as well: the config loader as the commands call it (find the file, import it, resolve
// the run), and the mail sink the core `Control` needs for health and cleanup.
import { loadMailSink } from '../adapters/mail/index.ts';
import { importKitConfig, loadRunConfig } from '../config/load.ts';
import { handleForAddress } from '../core/catalog.ts';
import type { Catalog, MailSink, MailSinkRef, RunConfig, TestApiClient } from '../types.ts';
import { findProject } from './project.ts';

export { createKeySource } from '../adapters/key/index.ts';
export { namespaceFor, newRunId } from '../config/load.ts';
export { startBroker } from '../core/broker.ts';
export { loadCatalog } from '../core/catalog.ts';
export { Control } from '../core/control.ts';
export { loadContractRoutes, mergeRoutes } from '../core/routes.ts';
export { forEachRegisteredSecret, runnerKeyFromRunner, Secret } from '../core/secret.ts';
export { TestApiClient } from '../core/test-api-client.ts';
export { postRunMain, Redactor } from '../evidence/index.ts';
export { compare } from '../evidence/report.ts';
export { scanDir, scanExitCode } from '../evidence/scan.ts';
export { scrubDir } from '../evidence/scrub.ts';
export { DEFAULT_ANSWERS, type InitAnswers, writeTemplates } from '../templates/index.ts';

export interface LoadProjectConfigOptions {
  /** an explicit config file (`--config`); otherwise the nearest `<kit>.config.*` above `cwd` */
  configPath?: string;
  cwd?: string;
  /** the environment the run is resolved from (never one holding a secret) */
  env?: NodeJS.ProcessEnv;
}

/** Find, import and validate the project's config, then resolve this run from `env`. Throws on anything unsafe. */
export async function loadProjectConfig(options: LoadProjectConfigOptions = {}): Promise<RunConfig> {
  const project = findProject(options.cwd ?? process.cwd(), options.configPath);
  const { config, dir } = await importKitConfig(project.configFile);
  return loadRunConfig(options.env ?? process.env, config, { configDir: dir });
}

export interface MailSinkContext {
  /** the namespace whose addresses the sink maps back to handles */
  ns: string;
  catalog: Catalog;
}

/** The configured mail sink over a client (the `test-api` sink needs the address-to-handle map of a namespace). */
export function mailSinkFor(
  api: TestApiClient,
  ref: MailSinkRef | undefined,
  context: MailSinkContext,
): Promise<MailSink> {
  return loadMailSink(ref ?? { sink: 'test-api' }, {
    testApi: { api, handleFor: (address) => handleForAddress(address, context.ns, context.catalog) },
  });
}
