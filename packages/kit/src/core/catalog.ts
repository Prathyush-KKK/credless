// The persona catalog (personas.yaml): loaded once, validated, and resolved per namespace into the accounts the
// runner creates on the target. Personas are roles, not accounts; the namespace makes them accounts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { type Catalog, PATTERNS, type Persona, type PersonaSpec } from '../types.ts';

const personaAuth = z.enum(['session', 'password']);

// Keys that would make a catalog carry a credential: refused wherever they appear in an entry's attributes.
const CREDENTIAL_KEY = /password|passwd|token|secret/i;

const attributes = z
  .record(z.string(), z.unknown())
  .refine((value) => !Object.keys(value).some((k) => CREDENTIAL_KEY.test(k)), {
    message: 'attributes must not carry a password, token or secret; the backend holds those',
  });

const entry = z.strictObject({
  role: z.string().min(1),
  firstName: z.string().min(1),
  auth: personaAuth.optional(),
  locale: z.string().min(2).optional(),
  timezone: z.string().min(1).optional(),
  countryCode: z.string().length(2).optional(),
  attributes: attributes.optional(),
  purpose: z.string().min(1),
  usedBy: z.array(z.string()).optional(),
});

const address = z.strictObject({
  template: z.string().includes('{ns}', { message: 'an address template must contain {ns}' }),
  purpose: z.string().min(1),
});

/** The catalog's shape (types.ts `Catalog`); rules the schema cannot express are checked by {@link parseCatalog}. */
export const catalogSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(['draft', 'confirmed']).optional(),
  addressTemplate: z
    .string()
    .includes('{ns}', { message: 'addressTemplate must contain {ns}' })
    .includes('{persona}', { message: 'addressTemplate must contain {persona}' }),
  lastNameTemplate: z.string().includes('{ns}', { message: 'lastNameTemplate must contain {ns}' }),
  defaults: z.strictObject({
    locale: z.string().min(2),
    timezone: z.string().min(1),
    countryCode: z.string().length(2).optional(),
    auth: personaAuth,
  }),
  personas: z.record(
    z.string().regex(PATTERNS.personaId, 'a persona id is lowercase letters, digits and hyphens'),
    entry,
  ),
  addresses: z
    .record(z.string().regex(PATTERNS.personaId, 'an address name is lowercase letters, digits and hyphens'), address)
    .optional(),
});

export interface CatalogOptions {
  /** `personas.addressPattern`: every rendered address must match it (the test API enforces the same range) */
  addressPattern?: string | RegExp;
}

function addressRange(pattern: string | RegExp | undefined): RegExp | null {
  if (pattern === undefined) return null;
  return typeof pattern === 'string' ? new RegExp(pattern) : pattern;
}

function renderAddress(template: string, ns: string, persona: string): string {
  return template.replaceAll('{ns}', ns).replaceAll('{persona}', persona);
}

/** Parse and validate a catalog document. Throws with every schema problem listed. */
export function parseCatalog(text: string, options: CatalogOptions = {}): Catalog {
  const doc: unknown = YAML.parse(text);
  const parsed = catalogSchema.safeParse(doc);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const where = i.path.length ? `/${i.path.join('/')}` : '/';
      // zod names a bad record key generically; say what the key had to look like
      const message =
        i.message === 'Invalid key in record'
          ? `"${String(i.path.at(-1))}" is not a ${i.path[0] === 'addresses' ? 'valid address name' : 'persona id'} (${PATTERNS.personaId.source})`
          : i.message;
      return `${where} ${message}`;
    });
    throw new Error(`the persona catalog is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  const catalog = parsed.data as Catalog;
  const range = addressRange(options.addressPattern);
  // Rules a schema cannot express.
  const firstNames = new Map<string, string>();
  for (const [id, persona] of Object.entries(catalog.personas)) {
    const other = firstNames.get(persona.firstName);
    if (other) {
      throw new Error(
        `catalog: ${id} and ${other} share the first name ${persona.firstName}; screenshots must tell people apart`,
      );
    }
    firstNames.set(persona.firstName, id);
    const sample = renderAddress(catalog.addressTemplate, 'a0', id);
    if (range && !range.test(sample))
      throw new Error(`catalog: ${id} renders to ${sample}, outside the address pattern ${range.source}`);
  }
  for (const [name, entry] of Object.entries(catalog.addresses ?? {})) {
    if (catalog.personas[name]) throw new Error(`catalog: ${name} is both a persona and an address`);
    const sample = entry.template.replaceAll('{ns}', 'a0');
    if (range && !range.test(sample))
      throw new Error(`catalog: address ${name} renders to ${sample}, outside the address pattern ${range.source}`);
  }
  return catalog;
}

/** Read and validate a catalog file. */
export function loadCatalog(file: string, options: CatalogOptions = {}): Catalog {
  return parseCatalog(fs.readFileSync(file, 'utf8'), options);
}

/** SHA-256 of the catalog file's bytes, for run.json. */
export function catalogDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function assertNamespace(ns: string): void {
  if (!PATTERNS.namespace.test(ns)) throw new Error(`namespace must look like a0 (got "${ns}")`);
}

/** The namespace of a worker: slot letter plus parallel index, for example `a0`. Accounts are created per namespace. */
export function namespaceFor(slot: string, parallelIndex: number): string {
  if (!PATTERNS.slot.test(slot)) throw new Error(`slot must be one lowercase letter (got "${slot}")`);
  if (!Number.isInteger(parallelIndex) || parallelIndex < 0 || parallelIndex > 99) {
    throw new Error(`parallel index out of range: ${parallelIndex}`);
  }
  return `${slot}${parallelIndex}`;
}

/** The account for persona `id` in namespace `ns`. */
export function resolvePersona(id: string, ns: string, catalog: Catalog, options: CatalogOptions = {}): Persona {
  assertNamespace(ns);
  const entry = catalog.personas[id];
  if (!entry) throw new Error(`no persona "${id}" in the catalog (have: ${Object.keys(catalog.personas).join(', ')})`);
  const lastName = catalog.lastNameTemplate.replaceAll('{ns}', ns);
  const email = renderAddress(catalog.addressTemplate, ns, id);
  const range = addressRange(options.addressPattern);
  if (range && !range.test(email)) throw new Error(`persona ${id} renders to ${email}, outside the address pattern`);
  const countryCode = entry.countryCode ?? catalog.defaults.countryCode;
  return {
    id,
    ns,
    handle: `${ns}.${id}`,
    email,
    firstName: entry.firstName,
    lastName,
    displayName: `${entry.firstName} ${lastName}`,
    role: entry.role,
    auth: entry.auth ?? catalog.defaults.auth,
    locale: entry.locale ?? catalog.defaults.locale,
    timezone: entry.timezone ?? catalog.defaults.timezone,
    ...(countryCode ? { countryCode } : {}),
    attributes: { ...(entry.attributes ?? {}) },
  };
}

/** Every persona in a namespace, in catalog order. */
export function personasIn(ns: string, catalog: Catalog, options: CatalogOptions = {}): Persona[] {
  return Object.keys(catalog.personas).map((id) => resolvePersona(id, ns, catalog, options));
}

/** A non-account address from the catalog (for example `ghost`), in namespace `ns`. */
export function resolveAddress(name: string, ns: string, catalog: Catalog): string {
  assertNamespace(ns);
  const entry = catalog.addresses?.[name];
  if (!entry)
    throw new Error(`no address "${name}" in the catalog (have: ${Object.keys(catalog.addresses ?? {}).join(', ')})`);
  return entry.template.replaceAll('{ns}', ns);
}

/** A persona id or an address name to an email address in `ns`; persona ids win when a name is both. */
export function addressFor(to: string, ns: string, catalog: Catalog): string {
  return catalog.personas[to] ? resolvePersona(to, ns, catalog).email : resolveAddress(to, ns, catalog);
}

/** The handle whose address this is in `ns`, or null for an address that is not an account (a catalog address). */
export function handleForAddress(address: string, ns: string, catalog: Catalog): string | null {
  const wanted = address.toLowerCase();
  for (const id of Object.keys(catalog.personas)) {
    if (renderAddress(catalog.addressTemplate, ns, id).toLowerCase() === wanted) return `${ns}.${id}`;
  }
  return null;
}

/** The persona id of a handle in `ns`; throws when the backend answered with a handle outside the namespace. */
export function personaIdOf(handle: string, ns: string): string {
  const dot = handle.indexOf('.');
  const handleNs = dot > 0 ? handle.slice(0, dot) : '';
  const id = dot > 0 ? handle.slice(dot + 1) : '';
  if (handleNs !== ns || !id) throw new Error(`the backend returned ${handle}, outside namespace ${ns}`);
  return id;
}

/**
 * What `ensurePersonas` sends for a persona (contract `PersonaSpec`): the well-known keys the kit always sends plus
 * the catalog entry's own attributes, which never override the well-known ones.
 */
export function personaSpec(persona: Persona): PersonaSpec {
  return {
    handle: persona.handle,
    email: persona.email,
    displayName: persona.displayName,
    attributes: {
      ...persona.attributes,
      role: persona.role,
      firstName: persona.firstName,
      lastName: persona.lastName,
      locale: persona.locale,
      timezone: persona.timezone,
      ...(persona.countryCode ? { countryCode: persona.countryCode } : {}),
      auth: persona.auth,
    },
  };
}
