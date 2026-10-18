// Route tables: the seven core routes (CORE_ROUTES in types.ts, source of truth contract/core.openapi.yaml) plus an
// app's extension routes read from its own OpenAPI file. The client resolves operationIds here; the broker's
// allowlist is the same table, so a worker can reach exactly the routes the contracts name and nothing else.
import fs from 'node:fs';
import YAML from 'yaml';
import { CORE_ROUTES, type HttpMethod, type RouteDef, type RouteTable } from '../types.ts';

export { CORE_ROUTES };

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface OpenApiDocument {
  paths?: Record<string, Record<string, { operationId?: string } | undefined> | undefined>;
}

/**
 * The operations of an OpenAPI file (YAML or JSON, read from disk, no `$ref` resolution and no network) as a route
 * table keyed by operationId. Paths are taken as written, relative to the test API's base path like the core ones.
 */
export function loadContractRoutes(openapiFile: string): RouteTable {
  const doc = YAML.parse(fs.readFileSync(openapiFile, 'utf8')) as OpenApiDocument | null;
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    throw new Error(`${openapiFile} is not an OpenAPI document (no paths)`);
  }
  const routes: Record<string, RouteDef> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item) continue;
    if (!path.startsWith('/')) throw new Error(`${openapiFile}: path ${path} does not start with /`);
    for (const [verb, operation] of Object.entries(item)) {
      const method = verb.toUpperCase() as HttpMethod;
      if (!METHODS.includes(method) || !operation) continue;
      const operationId = operation.operationId;
      if (!operationId) throw new Error(`${openapiFile}: ${method} ${path} has no operationId`);
      if (routes[operationId]) throw new Error(`${openapiFile}: operationId ${operationId} is used twice`);
      routes[operationId] = { method, path };
    }
  }
  return routes;
}

/**
 * Core plus extension routes. An extension may restate a core route only identically; a new operationId on a core
 * method+path, or two operationIds on one method+path, is a contract error.
 */
export function mergeRoutes(core: RouteTable, app: RouteTable = {}): RouteTable {
  const merged: Record<string, RouteDef> = { ...core };
  const byLine = new Map<string, string>(Object.entries(core).map(([id, r]) => [`${r.method} ${r.path}`, id]));
  for (const [id, route] of Object.entries(app)) {
    const line = `${route.method} ${route.path}`;
    const existing = merged[id];
    if (existing && (existing.method !== route.method || existing.path !== route.path)) {
      throw new Error(
        `route ${id} is ${existing.method} ${existing.path} in the core contract and ${line} in the app's`,
      );
    }
    const sameLine = byLine.get(line);
    if (sameLine && sameLine !== id) throw new Error(`${line} is both ${sameLine} and ${id}`);
    merged[id] = route;
    byLine.set(line, id);
  }
  return merged;
}

/** Fill `{param}` placeholders; values are URL-encoded, so a handle or id can never add a path segment. */
export function fillPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`route ${path} needs {${key}}`);
    return encodeURIComponent(String(value));
  });
}

/** The placeholder names of a route path, in order: `/runs/{runId}/cleanup` gives `['runId']`. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
}

export interface RouteMatcher {
  /** the operationId of the route a request line hits under the base path, or null */
  match(method: string, pathname: string): string | null;
}

/** A matcher over a table: method plus exact path shape (a placeholder matches one non-empty segment). */
export function routeMatcher(routes: RouteTable, basePath: string): RouteMatcher {
  const base = basePath.replace(/\/+$/, '');
  const compiled = Object.entries(routes).map(([id, r]) => ({
    id,
    method: r.method,
    regex: new RegExp(`^${escapeRegExp(base + r.path).replace(/\\\{\w+\\\}/g, '[^/]+')}$`),
  }));
  return {
    match(method, pathname) {
      const hit = compiled.find((r) => r.method === method && r.regex.test(pathname));
      return hit ? hit.id : null;
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
