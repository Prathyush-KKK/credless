// The contract check's rules (checks/contract.ts) on the real contract files with synthetic server tables, and the
// catalog check (checks/catalog.ts) on the demo's catalog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkCatalog } from '../../src/checks/catalog.ts';
import { checkContracts } from '../../src/checks/contract.ts';
import { loadContractRoutes } from '../../src/core/routes.ts';
import { CORE_ROUTES, type RouteTable } from '../../src/types.ts';

const root = path.resolve(import.meta.dirname, '../../../..');
const coreFile = path.join(root, 'contract/core.openapi.yaml');
const appFile = path.join(root, 'apps/demo/contract/demo.openapi.yaml');
const catalogFile = path.join(root, 'apps/demo/e2e/personas.yaml');
const ADDRESS = '^qa\\+[a-z0-9-]+@example\\.com$';

const served = (): RouteTable => ({ ...CORE_ROUTES, ...loadContractRoutes(appFile) });

describe('check:contract', () => {
  test('the core contract is CORE_ROUTES, and a server serving core plus the demo contract agrees', () => {
    const { problems, routes } = checkContracts({ coreFile, appFile, handlerRoutes: served() });
    expect(problems).toEqual([]);
    expect(Object.keys(routes)).toEqual([
      ...Object.keys(CORE_ROUTES),
      'createWorkspace',
      'getWorkspace',
      'deleteWorkspace',
      'lockLink',
      'expireInvite',
      'runSweeper',
      'getDocument',
    ]);
  });

  test('a route the server forgot, one it invented, and one on the wrong line are named', () => {
    const { getWorkspace: _dropped, ...missing } = served();
    expect(checkContracts({ coreFile, appFile, handlerRoutes: missing }).problems).toEqual([
      'the server does not implement getWorkspace (GET /workspaces/{id})',
    ]);
    const extra = { ...served(), nukeEverything: { method: 'DELETE' as const, path: '/everything' } };
    expect(checkContracts({ coreFile, appFile, handlerRoutes: extra }).problems).toEqual([
      'the server serves nukeEverything (DELETE /everything), which is in no contract',
    ]);
    const wrong = { ...served(), lockLink: { method: 'PUT' as const, path: '/workspaces/{id}/lock-link' } };
    expect(checkContracts({ coreFile, appFile, handlerRoutes: wrong }).problems).toEqual([
      'the server serves lockLink as PUT /workspaces/{id}/lock-link; the contract says POST /workspaces/{id}/lock-link',
    ]);
  });

  test('a contract path that spells the base path, or a server url on another base path, is a problem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-'));
    const file = path.join(dir, 'app.openapi.yaml');
    fs.writeFileSync(
      file,
      [
        'openapi: 3.1.0',
        "servers: [{ url: '{origin}/_other' }]",
        'paths:',
        '  /_test/widgets:',
        '    get: { operationId: listWidgets }',
      ].join('\n'),
    );
    const { problems } = checkContracts({
      coreFile,
      appFile: file,
      handlerRoutes: { ...CORE_ROUTES, listWidgets: { method: 'GET', path: '/_test/widgets' } },
    });
    expect(problems).toEqual([
      `${file}: listWidgets spells the base path (/_test/widgets); contract paths are relative to it`,
      `${file}: servers.url ends in /_other, not the base path /_test`,
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an extension that reuses a core operationId on another line is a clash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-'));
    const file = path.join(dir, 'app.openapi.yaml');
    fs.writeFileSync(
      file,
      [
        'openapi: 3.1.0',
        "servers: [{ url: '{origin}/_test' }]",
        'paths:',
        '  /health2:',
        '    get: { operationId: health }',
      ].join('\n'),
    );
    const { problems } = checkContracts({ coreFile, appFile: file, handlerRoutes: CORE_ROUTES });
    expect(problems[0]).toMatch(/route health is GET \/health in the core contract and GET \/health2/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('check:catalog', () => {
  test('the demo catalog validates and lists five personas and the ghost address in namespace a0', () => {
    const result = checkCatalog({ file: catalogFile, addressPattern: ADDRESS });
    expect(result.personas.map((p) => p.id)).toEqual(['owner', 'member', 'guest', 'second-owner', 'signin']);
    expect(result.personas.map((p) => p.firstName)).toEqual(['Ada', 'Ben', 'Cleo', 'Dev', 'Eve']);
    expect(result.personas.find((p) => p.id === 'signin')?.auth).toBe('password');
    expect(result.personas[0]?.email).toBe('qa+a0-owner@example.com');
    expect(result.personas[0]?.displayName).toBe('Ada QA-a0');
    expect(result.addresses).toEqual([
      { name: 'ghost', address: 'qa+a0-ghost@example.com', purpose: expect.any(String) },
    ]);
    expect(result.listing).toContain('second-owner   owner    session   qa+a0-second-owner@example.com');
  });

  test('a catalog outside the address range, or with two personas of one first name, is refused', () => {
    expect(() => checkCatalog({ file: catalogFile, addressPattern: '^qa\\+[a-z0-9-]+@other\\.example$' })).toThrow(
      /outside the address pattern/,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-check-'));
    const file = path.join(dir, 'personas.yaml');
    fs.writeFileSync(file, fs.readFileSync(catalogFile, 'utf8').replace('firstName: Ben', 'firstName: Ada'));
    expect(() => checkCatalog({ file, addressPattern: ADDRESS })).toThrow(/share the first name Ada/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
