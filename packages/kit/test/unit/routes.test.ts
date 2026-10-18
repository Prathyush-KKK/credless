// Route tables: the core contract file agrees with CORE_ROUTES, an app contract loads, tables merge safely, and
// path parameters can never add a segment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  CORE_ROUTES,
  fillPath,
  loadContractRoutes,
  mergeRoutes,
  pathParams,
  routeMatcher,
} from '../../src/core/routes.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-routes-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadContractRoutes', () => {
  test('the core contract file and CORE_ROUTES are the same seven routes', () => {
    expect(loadContractRoutes(path.join(repoRoot, 'contract', 'core.openapi.yaml'))).toEqual(CORE_ROUTES);
  });

  test('an app contract loads by operationId; a missing operationId or a duplicate is an error', () => {
    const app = path.join(dir, 'app.openapi.yaml');
    fs.writeFileSync(
      app,
      [
        'openapi: 3.1.0',
        'info: { title: app, version: 0.0.1 }',
        'paths:',
        '  /workspaces:',
        '    post: { operationId: createWorkspace, responses: { "200": { description: ok } } }',
        '    parameters: []',
        '  /workspaces/{id}:',
        '    get: { operationId: getWorkspace }',
        '    delete: { operationId: deleteWorkspace }',
      ].join('\n'),
    );
    expect(loadContractRoutes(app)).toEqual({
      createWorkspace: { method: 'POST', path: '/workspaces' },
      getWorkspace: { method: 'GET', path: '/workspaces/{id}' },
      deleteWorkspace: { method: 'DELETE', path: '/workspaces/{id}' },
    });
    const bad = path.join(dir, 'bad.openapi.yaml');
    fs.writeFileSync(bad, 'paths:\n  /x:\n    get: { summary: no id }\n');
    expect(() => loadContractRoutes(bad)).toThrow(/has no operationId/);
    fs.writeFileSync(bad, 'paths:\n  /x:\n    get: { operationId: a }\n  /y:\n    get: { operationId: a }\n');
    expect(() => loadContractRoutes(bad)).toThrow(/used twice/);
    fs.writeFileSync(bad, 'info: {}\n');
    expect(() => loadContractRoutes(bad)).toThrow(/no paths/);
  });
});

describe('mergeRoutes', () => {
  test('core plus app; an app may not redefine a core operation or reuse a core line', () => {
    const merged = mergeRoutes(CORE_ROUTES, { createWorkspace: { method: 'POST', path: '/workspaces' } });
    expect(Object.keys(merged)).toHaveLength(8);
    expect(merged.health).toEqual(CORE_ROUTES.health);
    expect(mergeRoutes(CORE_ROUTES, { health: { method: 'GET', path: '/health' } })).toEqual(CORE_ROUTES);
    expect(() => mergeRoutes(CORE_ROUTES, { health: { method: 'POST', path: '/health' } })).toThrow(
      /route health is GET \/health in the core contract/,
    );
    expect(() => mergeRoutes(CORE_ROUTES, { ping: { method: 'GET', path: '/health' } })).toThrow(
      /GET \/health is both health and ping/,
    );
    expect(mergeRoutes(CORE_ROUTES)).toEqual(CORE_ROUTES);
  });
});

describe('fillPath and the matcher', () => {
  test('parameters are URL-encoded and required', () => {
    expect(fillPath('/personas/{handle}', { handle: 'a0.owner' })).toBe('/personas/a0.owner');
    expect(fillPath('/personas/{handle}', { handle: 'a0/../../admin' })).toBe('/personas/a0%2F..%2F..%2Fadmin');
    expect(fillPath('/runs/{runId}/cleanup', { runId: 7 })).toBe('/runs/7/cleanup');
    expect(() => fillPath('/personas/{handle}')).toThrow(/needs \{handle\}/);
    expect(pathParams('/runs/{runId}/cleanup/{kind}')).toEqual(['runId', 'kind']);
    expect(pathParams('/health')).toEqual([]);
  });

  test('matches method and exact shape under the base path; a placeholder is one non-empty segment', () => {
    const m = routeMatcher(
      mergeRoutes(CORE_ROUTES, { getWorkspace: { method: 'GET', path: '/workspaces/{id}' } }),
      '/_test/',
    );
    expect(m.match('GET', '/_test/health')).toBe('health');
    expect(m.match('DELETE', '/_test/health')).toBeNull();
    expect(m.match('GET', '/_test/health/extra')).toBeNull();
    expect(m.match('GET', '/health')).toBeNull();
    expect(m.match('GET', '/_test/personas/a0.owner')).toBe('personaState');
    expect(m.match('GET', '/_test/personas/a0.owner/messages')).toBe('personaMessages');
    expect(m.match('GET', '/_test/personas/')).toBeNull();
    expect(m.match('GET', '/_test/personas/a0/owner')).toBeNull();
    expect(m.match('POST', '/_test/runs/20261008T101500Z-ab12/cleanup')).toBe('cleanupRun');
    expect(m.match('GET', '/_test/workspaces/42')).toBe('getWorkspace');
    expect(m.match('GET', '/_testX/health')).toBeNull();
  });
});
