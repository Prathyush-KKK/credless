// `<kit>/config` (plan §4.1): `defineConfig`, the zod schema and the loader.
//
// Task 0 stub. Task 1 implements config/schema.ts (zod 4) and config/load.ts (targets, production detection, run id,
// slot, namespace; port of the private config.ts) and re-exports them here.
import type { KitConfig, RunConfig } from '../types.ts';

export type {
  BrowserProjectConfig,
  ControlRef,
  DockerConfig,
  EvidenceConfig,
  ExecPreset,
  HostGlob,
  HostsConfig,
  KeySourceRef,
  KitConfig,
  MailSinkRef,
  OutsideMode,
  PersonasConfig,
  ProductionConfig,
  RunConfig,
  SessionProviderRef,
  Target,
  TargetKind,
  TestApiConfig,
  TraceMode,
} from '../types.ts';
export { DEFAULTS, ENV, PATTERNS } from '../types.ts';

/** Validate a config (zod 4) and return it with defaults filled in. The only export a `<kit>.config.ts` needs. */
export function defineConfig(_config: KitConfig): KitConfig {
  throw new Error('TODO Task 1: defineConfig()');
}

/** Load `<kit>.config.ts` from `cwd` (or the given path) and resolve this run's config from the environment. */
export async function loadRunConfig(_options?: { configPath?: string; env?: NodeJS.ProcessEnv }): Promise<RunConfig> {
  throw new Error('TODO Task 1: loadRunConfig()');
}

/** Production, or anything that could be, under the config's rules. Never relaxed by a target. */
export function isProductionHost(
  _hostname: string,
  _config: Pick<KitConfig, 'production'>,
  _targetHosts: string[],
): boolean {
  throw new Error('TODO Task 1: isProductionHost()');
}

/** A new run id (`PATTERNS.runId`). */
export function newRunId(_now?: Date): string {
  throw new Error('TODO Task 1: newRunId()');
}

/** The namespace of a worker: slot letter plus parallel index, for example `a0`. */
export function namespaceFor(_slot: string, _parallelIndex: number): string {
  throw new Error('TODO Task 1: namespaceFor()');
}
