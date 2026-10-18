// `<kit>/server` (plan §5): `createTestApi()`, the core contract handler a Node backend mounts under the base path.
// The demo app's src/test-api.ts is the reference use of it.
//
// Task 0 stub. Task 5 implements it against contract/core.openapi.yaml: constant-time key check, 401/403/404/422
// as the contract says, plain JSON answers with `{ error: { code, message } }` on refusals, `Set-Cookie` on
// `/session`, and `extensions` in health.
import type { TestApiHandler, TestApiServerOptions } from '../types.ts';

export type {
  ApiErrorBody,
  CleanupRunRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  Health,
  MintedSession,
  PersonaRef,
  PersonaSpec,
  PersonaState,
  ResetResult,
  TestApiHandler,
  TestApiServerOptions,
  WireMessage,
} from '../types.ts';
export { CORE_ROUTES, DEFAULTS } from '../types.ts';

export function createTestApi(_options: TestApiServerOptions): TestApiHandler {
  throw new Error('TODO Task 5: createTestApi()');
}
