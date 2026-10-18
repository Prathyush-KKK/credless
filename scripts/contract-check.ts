// `node scripts/contract-check.ts`: the kit's client routes, the two contracts and the demo's reference server agree
// (packages/kit/src/checks/contract.ts says how). Plain node, no build: the kit's `yaml` resolves from the kit's own
// source tree. Task 6 wires this into the root `contract:check` script.
import { fileURLToPath } from 'node:url';
import { DemoState } from '../apps/demo/src/state.ts';
import { createDemoTestApi } from '../apps/demo/src/test-api.ts';
import { runContractCheck } from '../packages/kit/src/checks/contract.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// The handler's route table is all the check needs; the key is a throwaway, nothing listens.
const demo = createDemoTestApi(new DemoState({ webOrigin: 'http://127.0.0.1', signinPassword: 'unused' }), {
  key: 'contract-check',
});

process.exit(
  runContractCheck({
    coreFile: `${root}contract/core.openapi.yaml`,
    appFile: `${root}apps/demo/contract/demo.openapi.yaml`,
    handlerRoutes: demo.routes,
  }),
);
