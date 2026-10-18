// `<kit>/adapters` (plan §4.2): the adapter interfaces, the built-ins and the `Control` base class apps extend.
//
// Task 0 stub. Task 1 implements adapters/{session,state,key,mail,signals}.ts, adapters/key/{env,file,exec,keyring}.ts
// and core/control.ts (`Control`, `ControlOptions`) and re-exports them here. The factory signatures are frozen.
import type {
  AppSignals,
  KeySource,
  KeySourceRef,
  MailSink,
  MailSinkRef,
  SessionProvider,
  SessionProviderRef,
} from '../types.ts';

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
  SecretValue,
  SessionGrant,
  SessionProvider,
  SessionProviderRef,
  SignalInput,
  StateControl,
  TestApiClient,
  TestApiError,
  Transport,
} from '../types.ts';

/** The built-in key source for a config reference (`env`, `file`, `exec`, `keyring`). */
export function createKeySource(_ref: KeySourceRef): KeySource {
  throw new Error('TODO Task 1: createKeySource()');
}

/** The built-in session provider for a config reference (`test-api`, `storage-state-file`). */
export function createSessionProvider(_ref: SessionProviderRef): SessionProvider {
  throw new Error('TODO Task 1: createSessionProvider()');
}

/** The built-in mail sink for a config reference (`test-api`, `mailpit`). */
export function createMailSink(_ref: MailSinkRef): MailSink {
  throw new Error('TODO Task 1: createMailSink()');
}

/** The default signals (401 on the api origin is a sign-out; status >= 400 is an API error) with the config's overrides. */
export function resolveSignals(_overrides?: Partial<AppSignals>): AppSignals {
  throw new Error('TODO Task 1: resolveSignals()');
}
