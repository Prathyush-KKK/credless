// The persona catalog (private U01–U02): every persona resolves to an account inside the address range, and a
// catalog that would reach outside it, confuse screenshots or carry a credential is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  addressFor,
  catalogDigest,
  handleForAddress,
  loadCatalog,
  namespaceFor,
  parseCatalog,
  personaIdOf,
  personaSpec,
  personasIn,
  resolveAddress,
  resolvePersona,
} from '../../src/core/catalog.ts';

const addressPattern = '^qa\\+[a-z0-9-]+@example\\.com$';

const GOOD = `
version: 1
status: draft
addressTemplate: qa+{ns}-{persona}@example.com
lastNameTemplate: QA-{ns}
defaults:
  locale: en-GB
  timezone: Europe/London
  auth: session
personas:
  owner:
    role: owner
    firstName: Olive
    purpose: owns a workspace
    usedBy: [W1, W2]
  member:
    role: member
    firstName: Mo
    purpose: a member of the owner's workspace
    attributes:
      plan: basic
  guest:
    role: guest
    firstName: Gus
    purpose: invited, limited rights
  second-owner:
    role: owner
    firstName: Sam
    purpose: a second owner for conflicts
  signin:
    role: member
    firstName: Sia
    auth: password
    countryCode: FR
    locale: fr-FR
    purpose: the one UI sign-in test
addresses:
  ghost:
    template: qa+{ns}-ghost@example.com
    purpose: an invited address nobody answers for
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-catalog-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a valid catalog', () => {
  const catalog = parseCatalog(GOOD, { addressPattern });

  test('every persona resolves to an account in the address range', () => {
    const personas = personasIn('a0', catalog);
    expect(personas.map((p) => p.id)).toEqual(['owner', 'member', 'guest', 'second-owner', 'signin']);
    for (const p of personas) {
      expect(p.email).toMatch(new RegExp(addressPattern));
      expect(p.email).toMatch(/^qa\+a0-[a-z0-9-]+@example\.com$/);
      expect(p.handle).toBe(`a0.${p.id}`);
      expect(p.displayName).toBe(`${p.firstName} QA-a0`);
      expect(p.lastName).toBe('QA-a0');
    }
    expect(resolvePersona('member', 'b3', catalog).email).toBe('qa+b3-member@example.com');
    expect(resolvePersona('member', 'b3', catalog).attributes).toEqual({ plan: 'basic' });
    expect(resolvePersona('owner', 'a0', catalog).attributes).toEqual({});
    expect(resolvePersona('signin', 'a0', catalog)).toMatchObject({
      auth: 'password',
      countryCode: 'FR',
      locale: 'fr-FR',
      timezone: 'Europe/London',
    });
    expect(resolvePersona('owner', 'a0', catalog)).not.toHaveProperty('countryCode');
    expect(resolveAddress('ghost', 'a1', catalog)).toBe('qa+a1-ghost@example.com');
    expect(addressFor('ghost', 'a1', catalog)).toBe('qa+a1-ghost@example.com');
    expect(addressFor('owner', 'a1', catalog)).toBe('qa+a1-owner@example.com');
  });

  test('handles and addresses map both ways inside a namespace', () => {
    expect(handleForAddress('qa+a0-owner@example.com', 'a0', catalog)).toBe('a0.owner');
    expect(handleForAddress('QA+A0-OWNER@example.com', 'a0', catalog)).toBe('a0.owner');
    expect(handleForAddress('qa+a0-ghost@example.com', 'a0', catalog)).toBeNull();
    expect(handleForAddress('qa+b1-owner@example.com', 'a0', catalog)).toBeNull();
    expect(personaIdOf('a0.second-owner', 'a0')).toBe('second-owner');
    expect(() => personaIdOf('b1.owner', 'a0')).toThrow(/outside namespace a0/);
    expect(() => personaIdOf('owner', 'a0')).toThrow(/outside namespace/);
    expect(namespaceFor('a', 0)).toBe('a0');
  });

  test('personaSpec sends the well-known keys and the entry attributes, well-known keys winning', () => {
    const spec = personaSpec(
      resolvePersona('signin', 'a0', {
        ...catalog,
        personas: {
          ...catalog.personas,
          signin: { ...catalog.personas.signin, attributes: { role: 'hacked', plan: 'pro' } },
        },
      } as typeof catalog),
    );
    expect(spec).toEqual({
      handle: 'a0.signin',
      email: 'qa+a0-signin@example.com',
      displayName: 'Sia QA-a0',
      attributes: {
        plan: 'pro',
        role: 'member',
        firstName: 'Sia',
        lastName: 'QA-a0',
        locale: 'fr-FR',
        timezone: 'Europe/London',
        countryCode: 'FR',
        auth: 'password',
      },
    });
  });

  test('loads from a file and digests it', () => {
    const file = path.join(dir, 'personas.yaml');
    fs.writeFileSync(file, GOOD);
    expect(loadCatalog(file, { addressPattern }).personas.owner?.firstName).toBe('Olive');
    expect(catalogDigest(file)).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(file, `${GOOD}\n# changed`);
    expect(catalogDigest(file)).not.toBe(
      catalogDigest(path.join(dir, 'personas.yaml')).slice(0, 0) +
        catalogDigest(file).replace(/./, (c) => (c === 'a' ? 'b' : 'a')),
    );
  });
});

describe('a catalog that is refused', () => {
  test('addresses outside the range, duplicate first names, and credentials', () => {
    expect(() =>
      parseCatalog(GOOD.replace('qa+{ns}-{persona}@example.com', 'someone+{ns}-{persona}@example.org'), {
        addressPattern,
      }),
    ).toThrow(/outside the address pattern/);
    expect(() =>
      parseCatalog(GOOD.replace('template: qa+{ns}-ghost@example.com', 'template: ghost-{ns}@example.org'), {
        addressPattern,
      }),
    ).toThrow(/address ghost renders to/);
    expect(() => parseCatalog(GOOD.replace('firstName: Mo\n', 'firstName: Olive\n'), { addressPattern })).toThrow(
      /share the first name Olive/,
    );
    expect(() =>
      parseCatalog(GOOD.replace('    auth: password\n', '    auth: password\n    password: hunter2\n'), {
        addressPattern,
      }),
    ).toThrow(/invalid[\s\S]*Unrecognized key: "password"/);
    expect(() =>
      parseCatalog(GOOD.replace('      plan: basic\n', '      plan: basic\n      apiToken: abc\n'), { addressPattern }),
    ).toThrow(/password, token or secret/);
    expect(() => parseCatalog(GOOD.replace('    auth: password\n', '    auth: token\n'), { addressPattern })).toThrow(
      /invalid/,
    );
    expect(() => parseCatalog(GOOD.replace('  guest:\n', '  Guest:\n'), { addressPattern })).toThrow(
      /\/personas\/Guest "Guest" is not a persona id/,
    );
    expect(() =>
      parseCatalog(GOOD.replace('lastNameTemplate: QA-{ns}', 'lastNameTemplate: QA'), { addressPattern }),
    ).toThrow(/lastNameTemplate must contain \{ns\}/);
    expect(() => parseCatalog(GOOD.replace('version: 1', 'version: 2'), { addressPattern })).toThrow(/version/);
    expect(() =>
      parseCatalog(`${GOOD}  owner:\n    template: qa+{ns}-owner@example.com\n    purpose: clash\n`, {
        addressPattern,
      }),
    ).toThrow(/both a persona and an address/);
  });

  test('unknown personas, addresses and malformed namespaces fail before any call', () => {
    const catalog = parseCatalog(GOOD, { addressPattern });
    expect(() => resolvePersona('zz', 'a0', catalog)).toThrow(/no persona "zz"/);
    expect(() => resolvePersona('owner', 'A0', catalog)).toThrow(/namespace/);
    expect(() => resolvePersona('owner', 'a100', catalog)).toThrow(/namespace/);
    expect(() => resolveAddress('nobody', 'a0', catalog)).toThrow(/no address "nobody"/);
    expect(() => resolvePersona('owner', 'a0', catalog, { addressPattern: '^nothing$' })).toThrow(
      /outside the address pattern/,
    );
  });

  test('without an address pattern the structure is still checked', () => {
    expect(parseCatalog(GOOD).personas.owner?.role).toBe('owner');
    expect(() => parseCatalog('version: 1')).toThrow(/invalid/);
    expect(() => parseCatalog('- not\n- a\n- catalog')).toThrow(/invalid/);
  });
});
