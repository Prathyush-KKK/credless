// `check:contract`: the client, the contracts and the reference server agree. The client's core routes
// (CORE_ROUTES) are exactly the core contract's; every route of core plus the app's contract has a handler with the
// same operationId, method and path; the server serves nothing the contracts do not name; and no path sits outside
// the base path (contract paths are relative to it, and both files declare the same base path).
import fs from 'node:fs';
import YAML from 'yaml';
import { loadContractRoutes, mergeRoutes } from '../core/routes.ts';
import { CORE_ROUTES, DEFAULTS, type RouteTable } from '../types.ts';

export interface ContractCheckInput {
  /** contract/core.openapi.yaml */
  coreFile: string;
  /** the app's extension contract, when it has one */
  appFile?: string;
  /** what the reference server serves, keyed by operationId (`createTestApi(...).routes`) */
  handlerRoutes: RouteTable;
  /** default {@link DEFAULTS.basePath} */
  basePath?: string;
}

export interface ContractCheckResult {
  /** empty when everything agrees */
  problems: string[];
  /** core plus app routes, keyed by operationId */
  routes: RouteTable;
}

const line = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

function serverBasePaths(file: string): string[] {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8')) as { servers?: Array<{ url?: string }> } | null;
  return (doc?.servers ?? []).map((s) => {
    const url = s.url ?? '';
    const at = url.indexOf('}/');
    return at >= 0 ? url.slice(at + 1) : new URL(url, 'http://127.0.0.1').pathname;
  });
}

/** Run the check. Throws only when a file cannot be read or parsed; disagreements come back as `problems`. */
export function checkContracts(input: ContractCheckInput): ContractCheckResult {
  const basePath = input.basePath ?? DEFAULTS.basePath;
  const problems: string[] = [];
  const core = loadContractRoutes(input.coreFile);
  const app = input.appFile ? loadContractRoutes(input.appFile) : {};

  // 1. The client's core table is the core contract, both ways.
  for (const [id, route] of Object.entries(CORE_ROUTES)) {
    const inContract = core[id];
    if (!inContract) problems.push(`client route ${id} (${line(route)}) is not in the core contract`);
    else if (line(inContract) !== line(route))
      problems.push(`client route ${id} is ${line(route)}; the core contract says ${line(inContract)}`);
  }
  for (const [id, route] of Object.entries(core)) {
    if (!(id in CORE_ROUTES))
      problems.push(`core contract route ${id} (${line(route)}) has no client call (CORE_ROUTES)`);
  }

  // 2. No route outside the base path: paths are relative, never spell the base path, and the files agree on it.
  for (const [file, routes] of [
    [input.coreFile, core],
    [input.appFile ?? '', app],
  ] as const) {
    if (!file) continue;
    for (const [id, route] of Object.entries(routes)) {
      if (route.path === basePath || route.path.startsWith(`${basePath}/`)) {
        problems.push(`${file}: ${id} spells the base path (${route.path}); contract paths are relative to it`);
      }
    }
    for (const declared of serverBasePaths(file)) {
      if (declared !== basePath)
        problems.push(`${file}: servers.url ends in ${declared}, not the base path ${basePath}`);
    }
  }

  // 3. Core and app merge without a clash (same operationId on two lines, or two operationIds on one line).
  let merged: RouteTable = core;
  try {
    merged = mergeRoutes(core, app);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  // 4. The reference server serves exactly the contracts' routes.
  for (const [id, route] of Object.entries(merged)) {
    const served = input.handlerRoutes[id];
    if (!served) problems.push(`the server does not implement ${id} (${line(route)})`);
    else if (line(served) !== line(route))
      problems.push(`the server serves ${id} as ${line(served)}; the contract says ${line(route)}`);
  }
  for (const [id, route] of Object.entries(input.handlerRoutes)) {
    if (!merged[id]) problems.push(`the server serves ${id} (${line(route)}), which is in no contract`);
  }

  return { problems, routes: merged };
}

/** The check as a command: prints the verdict and returns the exit code. */
export function runContractCheck(input: ContractCheckInput): number {
  const { problems, routes } = checkContracts(input);
  if (problems.length) {
    console.error(`contract check FAILED:\n  - ${problems.join('\n  - ')}`);
    return 1;
  }
  const extensions = Object.keys(routes).length - Object.keys(CORE_ROUTES).length;
  console.log(
    `contract check: ${Object.keys(routes).length} routes (${Object.keys(CORE_ROUTES).length} core, ${extensions} extension); client, contracts and server agree`,
  );
  return 0;
}
