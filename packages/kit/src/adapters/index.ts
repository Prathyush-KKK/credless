// `<kit>/adapters` (plan §4.2): the adapter interfaces, the built-ins and the `Control` base class apps extend.
//
// Built-ins: key sources `env`, `file`, `exec` (presets `op`, `infisical`, `doppler`, `vault`, `kubectl`) and
// `keyring`; session providers `test-api` and `storage-state-file`; mail sinks `test-api` and `mailpit`; the
// default signals. The low-level pieces an extension or a fixture needs (the client, the broker, the session
// helpers, `Secret`) are exported here too. The stub's factory names (`createKeySource`, ...) stay as aliases.

export { type StartBrokerOptions, startBroker } from '../core/broker.ts';
export {
  addressFor,
  assertNamespace,
  catalogDigest,
  catalogSchema,
  handleForAddress,
  loadCatalog,
  namespaceFor,
  parseCatalog,
  personaIdOf,
  personaSpec,
  personasIn,
  resolveAddress,
  resolvePersona,
} from '../core/catalog.ts';
export { Control, type Remover } from '../core/control.ts';
export { fillPath, loadContractRoutes, mergeRoutes, pathParams, routeMatcher } from '../core/routes.ts';
export {
  addRedactionCookies,
  addRedactionHeaders,
  forEachRegisteredSecret,
  redact,
  registeredSecretCount,
  registerSecretValue,
  runnerKeyFromRunner,
  Secret,
  sanitizedError,
  secretFromFile,
  signinPasswordFromRunner,
  timingSafeEqualString,
} from '../core/secret.ts';
export { type MintSessionOptions, mintSession, narrowCookies, parseSetCookie } from '../core/session.ts';
export { TestApiClient, type TestApiClientOptions, TestApiError } from '../core/test-api-client.ts';
export type {
  AppSignals,
  Broker,
  BrokerOptions,
  CallLogEntry,
  CallRequest,
  CallResult,
  CleanupResult,
  ControlInternals,
  ControlOptions,
  ExecPreset,
  Health,
  KeySource,
  KeySourceRef,
  MailMatch,
  MailQuery,
  MailSink,
  MailSinkRef,
  MailWaitOptions,
  Message,
  Persona,
  PersonaRef,
  PersonaSpec,
  PersonaState,
  ResetResult,
  RouteDef,
  RouteTable,
  SecretValue,
  SessionGrant,
  SessionProvider,
  SessionProviderRef,
  SignalInput,
  StateControl,
  Transport,
  WireMessage,
} from '../types.ts';
export { CORE_ROUTES, DEFAULTS } from '../types.ts';

export {
  createKeySource,
  EXEC_PRESETS,
  envKeySource,
  execArgv,
  execKeySource,
  fileKeySource,
  keyringKeySource,
  keySource,
} from './key/index.ts';
export {
  createMailSink,
  extractFromBody,
  loadMailSink,
  type MailpitOptions,
  type MailSinkDeps,
  mailpitMailSink,
  mailSink,
  messageMatches,
  pollForMessage,
  type TestApiMailOptions,
  testApiMailSink,
  toMessage,
} from './mail/index.ts';
export {
  createSessionProvider,
  loadSessionProvider,
  sessionProvider,
  storageStateFileSessionProvider,
  type TestApiSessionOptions,
  testApiSessionProvider,
} from './session/index.ts';
export { defaultSignals, resolveSignals, type SignalsContext } from './signals.ts';
