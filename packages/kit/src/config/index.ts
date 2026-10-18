// `<kit>/config` (plan §4.1): `defineConfig`, the zod schema and the loader.
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

export {
  assertNoProductionOverlap,
  assertTargetUrl,
  defaultStagingDir,
  hasProductionWord,
  hostMatchesRule,
  importKitConfig,
  isNonProdHost,
  isProdHost,
  isProductionHost,
  type LoadRunConfigOptions,
  loadRunConfig,
  namespaceFor,
  newRunId,
  pinRunId,
  ruleCouldMatchProduction,
  type TargetUrlConfig,
  targetHostsOf,
} from './load.ts';
export { defineConfig, describeIssues, kitConfigSchema } from './schema.ts';
